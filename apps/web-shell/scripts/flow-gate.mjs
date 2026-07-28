// 실앱 흐름 회귀 게이트 — 격리된 임시 state root와 free port에서 실제
// web-shell, daemon HTTP routes, run WebSocket을 띄워 핵심 사용자 흐름을
// 결정적으로 검증한다. 단위 테스트가 놓치는 데몬↔웹↔프로토콜 배선 회귀를
// 잡는 안전망.
//
// 실행: `npm run gate:flows -w apps/web-shell`
// 실패한 흐름은 output/playwright/flow-gate/<name>.png 스크린샷을 남긴다.
//
// 결정적 흐름만 담는다. reconnect vertical은 실제 live-run store와 run
// WebSocket을 쓰고, run vertical은 기존 Responses WebSocket session seam에
// 결정적 소켓만 공급한다. 둘 다 제품 owner를 그대로 지나며 라이브 provider
// quota를 쓰지 않는다. 새 흐름은 실제 owner-level 보장 위에 하나씩 추가한다.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  createArtifactRuntimeHostBootMessage,
} from '@geulbat/protocol/artifact-runtime-host';
import { chromium } from 'playwright';

import {
  resolveChromiumLaunchEnv,
  stopProcess,
  waitForDaemonReady,
} from './smoke-harness-utils.mjs';
import {
  buildFlowGateHotPathReport,
  observeFlowGateRunEventFrames,
} from './flow-gate-hot-path-report.mjs';
import {
  collectBrowserPerformanceEnvironment,
  writePrivatePerformanceReport,
} from './performance-report-support.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const screenshotDir = path.join(repoRoot, 'output', 'playwright', 'flow-gate');
const hotPathOutputPath = readStringOption('--hot-path-output');
const INITIAL_RECOVERY_COMMENTARY =
  'flow-gate: output visible before disconnect';
const BUFFERED_RECOVERY_COMMENTARY =
  'flow-gate: output buffered while disconnected';
const RECOVERY_THREAD_TITLE = 'Flow gate reconnect recovery';
const RUN_SETTLEMENT_PROMPT = 'flow-gate run start and settlement proof';
const RUN_STREAM_PREFIX = 'flow-gate: streamed-before-settlement';
const RUN_FINAL_SUFFIX = '::durably-settled';
const RUN_FINAL_TEXT = `${RUN_STREAM_PREFIX}${RUN_FINAL_SUFFIX}`;
const APPROVAL_PROMPT = 'flow-gate approval write proof';
const APPROVAL_CONTENT = 'flow-gate approved write\n';
const APPROVAL_FINAL_TEXT = 'flow-gate: approved write settled';
const ARTIFACT_PROMPT = 'flow-gate committed artifact proof';
const ARTIFACT_PREVIEW_MARKER = 'flow-gate committed artifact body';
const ARTIFACT_PAYLOAD = `
# Flow Gate Artifact

${ARTIFACT_PREVIEW_MARKER}
`;
const ARTIFACT_FINAL_TEXT = `<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"flow-gate-artifact-v1"} -->${ARTIFACT_PAYLOAD}<!-- /GEULBAT_ARTIFACT -->`;
const SUBAGENT_PARENT_PROMPT = 'flow-gate subagent control proof';
const SUBAGENT_CHILD_TASK = 'inspect the isolated flow-gate child session';
const SUBAGENT_FINAL_TEXT = 'flow-gate: subagent launched in background';
const MAX_CAPTURED_LOG_LINES = 80;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readStringOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

function appendProcessLogs(logs, chunk) {
  for (const line of String(chunk).split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    logs.push(line);
    if (logs.length > MAX_CAPTURED_LOG_LINES) {
      logs.shift();
    }
  }
}

function spawnCapturedProcess(command, args, options, logs) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => appendProcessLogs(logs, chunk));
  child.stderr?.on('data', (chunk) => appendProcessLogs(logs, chunk));
  return child;
}

async function reserveFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve(undefined))),
  );
  assert(port !== null, 'free port reservation did not return a TCP port');
  return port;
}

async function createIsolatedFlowGateHarness({ signal } = {}) {
  let appUrl;
  let approvalTargetPath;
  let daemon;
  let daemonOrigin;
  let devToken;
  let temporaryRoot;
  let closing;
  const daemonLogs = [];

  const requestFixture = async (pathname, body) => {
    const response = await fetch(new URL(pathname, daemonOrigin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        [DEV_TOKEN_HEADER_NAME]: devToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (
      !response.ok ||
      typeof payload !== 'object' ||
      payload === null ||
      payload.ok !== true
    ) {
      throw new Error(
        `flow-gate fixture request failed (${response.status}): ${pathname}`,
      );
    }
    return payload;
  };

  const close = () => {
    closing ??= (async () => {
      const stopResults = await Promise.allSettled([stopProcess(daemon)]);
      const stopFailures = stopResults
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (stopFailures.length > 0) {
        throw new AggregateError(
          stopFailures,
          'flow-gate child process cleanup failed',
        );
      }
      if (temporaryRoot !== undefined) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    })();
    return closing;
  };

  try {
    signal?.throwIfAborted();
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'geulbat-flow-gate-'),
    );
    signal?.throwIfAborted();
    const homeStateRoot = path.join(temporaryRoot, 'home-state');
    approvalTargetPath = path.join(temporaryRoot, 'approved-write.txt');
    devToken = randomBytes(32).toString('hex');
    const daemonPort = await reserveFreePort();
    signal?.throwIfAborted();
    daemonOrigin = `http://127.0.0.1:${daemonPort}`;
    // 데몬이 화면까지 서빙한다. 게이트는 제품과 같은 단일 origin 위상을
    // 검증해야 하므로 별도 dev server 포트를 두지 않는다.
    appUrl = `${daemonOrigin}/`;
    daemon = spawnCapturedProcess(
      process.execPath,
      ['--import', 'tsx', 'scripts/flow-gate-fixture.mjs'],
      {
        cwd: path.join(repoRoot, 'apps', 'daemon'),
        env: {
          ...process.env,
          GEULBAT_COMMAND_HOST: 'inline',
          GEULBAT_BACKEND_URL: `${daemonOrigin}/flow-gate/provider`,
          GEULBAT_DEV_TOKEN: devToken,
          GEULBAT_FLOW_GATE_ARTIFACT_FINAL_TEXT: ARTIFACT_FINAL_TEXT,
          GEULBAT_FLOW_GATE_ARTIFACT_PROMPT: ARTIFACT_PROMPT,
          GEULBAT_FLOW_GATE_APPROVAL_CONTENT: APPROVAL_CONTENT,
          GEULBAT_FLOW_GATE_APPROVAL_FINAL_TEXT: APPROVAL_FINAL_TEXT,
          GEULBAT_FLOW_GATE_APPROVAL_PROMPT: APPROVAL_PROMPT,
          GEULBAT_FLOW_GATE_APPROVAL_TARGET_PATH: approvalTargetPath,
          GEULBAT_FLOW_GATE_INITIAL_COMMENTARY: INITIAL_RECOVERY_COMMENTARY,
          GEULBAT_FLOW_GATE_RUN_FINAL_SUFFIX: RUN_FINAL_SUFFIX,
          GEULBAT_FLOW_GATE_RUN_SETTLEMENT_PROMPT: RUN_SETTLEMENT_PROMPT,
          GEULBAT_FLOW_GATE_RUN_STREAM_PREFIX: RUN_STREAM_PREFIX,
          GEULBAT_FLOW_GATE_SUBAGENT_CHILD_TASK: SUBAGENT_CHILD_TASK,
          GEULBAT_FLOW_GATE_SUBAGENT_FINAL_TEXT: SUBAGENT_FINAL_TEXT,
          GEULBAT_FLOW_GATE_SUBAGENT_PARENT_PROMPT: SUBAGENT_PARENT_PROMPT,
          GEULBAT_FLOW_GATE_THREAD_TITLE: RECOVERY_THREAD_TITLE,
          GEULBAT_FLOW_GATE_WORKING_DIRECTORY: repoRoot,
          GEULBAT_FLOW_GATE_SHELL_ASSET_ROOT: path.join(
            repoRoot,
            'apps',
            'web-shell',
            'dist',
          ),
          GEULBAT_HOME_STATE_ROOT: homeStateRoot,
          GEULBAT_LLM_PROVIDER: 'openai_codex_direct',
          GEULBAT_PROVIDER_AUTH_FILE_PATH: path.join(
            temporaryRoot,
            'provider-auth.json',
          ),
          GEULBAT_REPO_ROOT: repoRoot,
          HOST: '127.0.0.1',
          PORT: String(daemonPort),
        },
      },
      daemonLogs,
    );
    signal?.throwIfAborted();
    await waitForDaemonReady(`${daemonOrigin}/api/health`, daemonLogs, {
      signal,
    });
    signal?.throwIfAborted();
  } catch (error) {
    const detail = daemonLogs.slice(-24).join('\n');
    await close();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        detail === '' ? '' : `\n${detail}`
      }`,
    );
  }

  return {
    appUrl,
    approvalTargetPath,
    daemonOrigin,
    async publishBufferedCommentary(text, onDisconnected) {
      const disconnected = await requestFixture(
        '/api/flow-gate/recovery/disconnect',
        {},
      );
      assert(
        disconnected.disconnectedClientCount > 0,
        'recovery fixture did not disconnect an active WebSocket',
      );
      await onDisconnected();
      const payload = await requestFixture(
        '/api/flow-gate/recovery/commentary',
        { text },
      );
      assert(
        payload.delivery === 'buffered',
        `recovery output was ${String(payload.delivery)} instead of buffered`,
      );
    },
    async finishRecovery() {
      const payload = await requestFixture(
        '/api/flow-gate/recovery/finish',
        {},
      );
      assert(
        payload.persistedEventCount === payload.latestSeq + 1 &&
          payload.persistedEventCount > 0,
        'recovery journal did not persist the complete contiguous event history',
      );
    },
    async readHotPathMetrics(runId) {
      const query = new URLSearchParams({ runId });
      const payload = await requestFixture(
        `/api/flow-gate/hot-path/metrics?${query.toString()}`,
        undefined,
      );
      assert(
        typeof payload.metrics === 'object' && payload.metrics !== null,
        'flow-gate fixture returned malformed hot-path metrics',
      );
      return payload.metrics;
    },
    async completeProviderRun() {
      const payload = await requestFixture('/api/flow-gate/run/complete', {});
      assert(
        payload.providerRequestCount === 1,
        `run vertical dispatched ${String(
          payload.providerRequestCount,
        )} provider requests instead of one`,
      );
      assert(
        typeof payload.providerEvents === 'object' &&
          payload.providerEvents !== null &&
          typeof payload.providerEvents.eventCount === 'number' &&
          typeof payload.providerEvents.textDeltaCount === 'number',
        'run vertical returned malformed provider event evidence',
      );
      return {
        requestCount: payload.providerRequestCount,
        eventCount: payload.providerEvents.eventCount,
        textDeltaCount: payload.providerEvents.textDeltaCount,
      };
    },
    async readApprovalState() {
      const payload = await requestFixture(
        '/api/flow-gate/approval/status',
        undefined,
      );
      assert(
        typeof payload.exists === 'boolean' &&
          typeof payload.matchesExpectedContent === 'boolean' &&
          typeof payload.providerRequestCount === 'number',
        'approval fixture returned malformed evidence',
      );
      return {
        exists: payload.exists,
        matchesExpectedContent: payload.matchesExpectedContent,
        providerRequestCount: payload.providerRequestCount,
      };
    },
    async readArtifactRequestCount() {
      const payload = await requestFixture(
        '/api/flow-gate/artifact/status',
        undefined,
      );
      assert(
        typeof payload.providerRequestCount === 'number',
        'artifact fixture returned malformed provider evidence',
      );
      return payload.providerRequestCount;
    },
    async readSubagentState() {
      const payload = await requestFixture(
        '/api/flow-gate/subagent/status',
        undefined,
      );
      assert(
        typeof payload.parentRequestCount === 'number' &&
          typeof payload.childRequestCount === 'number',
        'subagent fixture returned malformed provider evidence',
      );
      return {
        parentRequestCount: payload.parentRequestCount,
        childRequestCount: payload.childRequestCount,
      };
    },
    close,
  };
}

async function preflight(appUrl) {
  const shellReachable = await fetch(appUrl)
    .then((response) => response.ok)
    .catch(() => false);
  assert(
    shellReachable,
    `isolated daemon does not serve the built web shell: ${appUrl} (run \`npm run build:app -w apps/web-shell\` first)`,
  );
  const daemonReachable = await fetch(new URL('api/health', appUrl))
    .then((response) => response.ok)
    .catch(() => false);
  assert(
    daemonReachable,
    'isolated daemon /api/health is not reachable at the shell origin',
  );
}

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

async function waitForTranscriptMarkerCount(page, expected) {
  await page.waitForFunction(
    ({ markers }) => {
      const transcript =
        document.querySelector('[aria-label="Assistant transcript"]')
          ?.textContent ?? '';
      return markers.every(
        ({ text, count }) => transcript.split(text).length - 1 === count,
      );
    },
    { markers: expected },
    { timeout: 15_000 },
  );
}

async function runReconnectReplayRecoveryFlow(page, harness) {
  const runEventFrames = observeFlowGateRunEventFrames(page);
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  await page
    .locator('textarea[name="assistant-message"]')
    .waitFor({ state: 'visible', timeout: 15_000 });
  const connected = page.locator('.assistant-title-dot.connected');
  await connected.waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const recoveryThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: RECOVERY_THREAD_TITLE });
  await recoveryThread.waitFor({ state: 'visible', timeout: 15_000 });
  await recoveryThread.click();
  await waitForTranscriptMarkerCount(page, [
    { text: INITIAL_RECOVERY_COMMENTARY, count: 1 },
  ]);

  const context = page.context();
  let browserHeldOffline = false;
  try {
    await harness.publishBufferedCommentary(
      BUFFERED_RECOVERY_COMMENTARY,
      async () => {
        await context.setOffline(true);
        browserHeldOffline = true;
      },
    );
  } finally {
    if (browserHeldOffline) {
      await context.setOffline(false);
    }
  }

  await connected.waitFor({ state: 'visible', timeout: 15_000 });
  await waitForTranscriptMarkerCount(page, [
    { text: INITIAL_RECOVERY_COMMENTARY, count: 1 },
    { text: BUFFERED_RECOVERY_COMMENTARY, count: 1 },
  ]);
  const transcript =
    (await page.locator('[aria-label="Assistant transcript"]').textContent()) ??
    '';
  assert(
    countOccurrences(transcript, INITIAL_RECOVERY_COMMENTARY) === 1,
    'pre-disconnect output was duplicated during cursor replay',
  );
  assert(
    countOccurrences(transcript, BUFFERED_RECOVERY_COMMENTARY) === 1,
    'buffered output did not replay exactly once after reconnect',
  );
  return runEventFrames.readSingleRun();
}

async function runStartAndSettlementFlow(page, harness) {
  const runEventFrames = observeFlowGateRunEventFrames(page);
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(RUN_SETTLEMENT_PROMPT);
  await page.getByRole('button', { name: '보내기' }).click();

  const cancelRun = page.getByRole('button', { name: '중단' });
  await cancelRun.waitFor({ state: 'visible', timeout: 15_000 });
  await waitForTranscriptMarkerCount(page, [
    { text: RUN_SETTLEMENT_PROMPT, count: 1 },
    { text: RUN_STREAM_PREFIX, count: 1 },
  ]);
  const streamingTranscript =
    (await page.locator('[aria-label="Assistant transcript"]').textContent()) ??
    '';
  assert(
    countOccurrences(streamingTranscript, RUN_FINAL_SUFFIX) === 0,
    'run settled before the browser released the deterministic provider',
  );

  const provider = await harness.completeProviderRun();
  await waitForTranscriptMarkerCount(page, [
    { text: RUN_SETTLEMENT_PROMPT, count: 1 },
    { text: RUN_FINAL_TEXT, count: 1 },
  ]);
  await cancelRun.waitFor({ state: 'hidden', timeout: 15_000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: RUN_SETTLEMENT_PROMPT });
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedThread.click();
  await waitForTranscriptMarkerCount(page, [
    { text: RUN_SETTLEMENT_PROMPT, count: 1 },
    { text: RUN_FINAL_TEXT, count: 1 },
  ]);
  const reloadedTranscript =
    (await page.locator('[aria-label="Assistant transcript"]').textContent()) ??
    '';
  assert(
    countOccurrences(reloadedTranscript, RUN_SETTLEMENT_PROMPT) === 1,
    'reloaded transcript did not preserve the user prompt exactly once',
  );
  assert(
    countOccurrences(reloadedTranscript, RUN_FINAL_TEXT) === 1,
    'reloaded transcript did not preserve the settled answer exactly once',
  );
  const browser = runEventFrames.readSingleRun();
  return {
    browser,
    daemon: await harness.readHotPathMetrics(browser.runId),
    provider,
  };
}

async function runApprovalFlow(page, harness) {
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(APPROVAL_PROMPT);
  await page.getByRole('button', { name: '보내기' }).click();

  const approvalDialog = page.locator('.approval-card');
  const cancelRun = page.getByRole('button', { name: '중단' });
  await approvalDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await cancelRun.waitFor({ state: 'visible', timeout: 15_000 });
  await waitForTranscriptMarkerCount(page, [
    { text: APPROVAL_PROMPT, count: 1 },
  ]);
  assert(
    ((await approvalDialog.textContent()) ?? '').includes(
      harness.approvalTargetPath,
    ),
    'approval dialog did not identify the exact temporary write target',
  );

  const beforeApproval = await harness.readApprovalState();
  assert(
    beforeApproval.exists === false &&
      beforeApproval.matchesExpectedContent === false,
    'write_file mutated the target before the browser approved it',
  );
  assert(
    beforeApproval.providerRequestCount === 1,
    `approval vertical dispatched ${String(
      beforeApproval.providerRequestCount,
    )} provider requests before approval instead of one`,
  );

  await approvalDialog
    .getByRole('button', { name: '허용', exact: true })
    .click();
  await waitForTranscriptMarkerCount(page, [
    { text: APPROVAL_PROMPT, count: 1 },
    { text: APPROVAL_FINAL_TEXT, count: 1 },
  ]);
  await approvalDialog.waitFor({ state: 'hidden', timeout: 15_000 });
  await cancelRun.waitFor({ state: 'hidden', timeout: 15_000 });

  const afterApproval = await harness.readApprovalState();
  assert(
    afterApproval.exists === true &&
      afterApproval.matchesExpectedContent === true,
    'approved write_file did not commit the exact temporary content',
  );
  assert(
    afterApproval.providerRequestCount === 2,
    `approval vertical dispatched ${String(
      afterApproval.providerRequestCount,
    )} provider requests after approval instead of two`,
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: APPROVAL_PROMPT });
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedThread.click();
  await waitForTranscriptMarkerCount(page, [
    { text: APPROVAL_PROMPT, count: 1 },
    { text: APPROVAL_FINAL_TEXT, count: 1 },
  ]);
  const reloadedTranscript =
    (await page.locator('[aria-label="Assistant transcript"]').textContent()) ??
    '';
  assert(
    countOccurrences(reloadedTranscript, APPROVAL_PROMPT) === 1,
    'reloaded approval transcript did not preserve the prompt exactly once',
  );
  assert(
    countOccurrences(reloadedTranscript, APPROVAL_FINAL_TEXT) === 1,
    'reloaded approval transcript did not preserve the answer exactly once',
  );
}

async function runArtifactOpaqueOriginIsolationFlow(page, harness) {
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const shellCookies = await page.context().cookies(harness.appUrl);
  const shellAuthCookie = shellCookies.find(
    (cookie) => cookie.name === 'geulbat_dev_auth',
  );
  assert(
    shellAuthCookie?.httpOnly === true && shellAuthCookie.sameSite === 'Strict',
    `single-origin shell did not install its HttpOnly strict auth cookie (${JSON.stringify(
      shellAuthCookie,
    )})`,
  );

  const parentOrigin = new URL(harness.appUrl).origin;
  const artifactHostUrl = new URL(
    '/artifact-runtime/host',
    harness.daemonOrigin,
  );
  artifactHostUrl.searchParams.set('parentOrigin', parentOrigin);
  const probeKind = 'geulbat.artifact_runtime_isolation_probe';
  const runtimeDocument = `<!doctype html>
<html>
  <body>
    <script>
      void (async () => {
        const parentOrigin = ${JSON.stringify(parentOrigin)};
        let parentDomReachable = false;
        try {
          parentDomReachable = window.parent.document.body !== null;
        } catch {
          parentDomReachable = false;
        }

        let cookieReadable = false;
        try {
          cookieReadable = document.cookie.length > 0;
        } catch {
          cookieReadable = false;
        }

        let fetchOutcome;
        try {
          const response = await fetch('/api/files/computer-scope', {
            credentials: 'include',
          });
          fetchOutcome = { kind: 'response', status: response.status };
        } catch {
          fetchOutcome = { kind: 'blocked' };
        }

        const websocketOutcome = await new Promise((resolve) => {
          const url = new URL('/api/ws', window.location.href);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(url);
          let settled = false;
          const finish = (outcome) => {
            if (settled) {
              return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            socket.close();
            resolve(outcome);
          };
          const timeoutId = window.setTimeout(
            () => finish({ kind: 'timeout' }),
            3_000,
          );
          socket.addEventListener(
            'open',
            () => finish({ kind: 'opened' }),
            { once: true },
          );
          socket.addEventListener(
            'error',
            () => finish({ kind: 'transport_error' }),
            { once: true },
          );
          socket.addEventListener(
            'close',
            () => finish({ kind: 'closed' }),
            { once: true },
          );
        });

        window.parent.postMessage(
          {
            kind: ${JSON.stringify(probeKind)},
            parentDomReachable,
            cookieReadable,
            fetchOutcome,
            websocketOutcome,
          },
          parentOrigin,
        );
      })();
    </script>
  </body>
</html>`;
  const bootMessage = createArtifactRuntimeHostBootMessage(runtimeDocument);

  const outcome = await page.evaluate(
    async ({
      bootMessage,
      frameUrl,
      hostMessageKind,
      hostReadyAction,
      probeKind,
    }) =>
      await new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
        iframe.src = frameUrl;
        let readyOrigin = null;
        const timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error('artifact opaque-origin probe timed out'));
        }, 10_000);
        const cleanup = () => {
          window.clearTimeout(timeoutId);
          window.removeEventListener('message', handleMessage);
          iframe.remove();
        };
        const handleMessage = (event) => {
          if (event.source !== iframe.contentWindow) {
            return;
          }
          const data = event.data;
          if (
            data &&
            typeof data === 'object' &&
            data.kind === hostMessageKind &&
            data.action === hostReadyAction
          ) {
            readyOrigin = event.origin;
            iframe.contentWindow?.postMessage(bootMessage, '*');
            return;
          }
          if (data && typeof data === 'object' && data.kind === probeKind) {
            const result = {
              ...data,
              readyOrigin,
              probeOrigin: event.origin,
            };
            cleanup();
            resolve(result);
          }
        };
        window.addEventListener('message', handleMessage);
        document.body.appendChild(iframe);
      }),
    {
      bootMessage,
      frameUrl: artifactHostUrl.toString(),
      hostMessageKind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
      hostReadyAction: ARTIFACT_RUNTIME_HOST_READY_ACTION,
      probeKind,
    },
  );

  assert(
    outcome.readyOrigin === 'null' && outcome.probeOrigin === 'null',
    `artifact frame did not receive an opaque origin (${JSON.stringify(outcome)})`,
  );
  assert(
    outcome.parentDomReachable === false && outcome.cookieReadable === false,
    `opaque artifact retained parent DOM or cookie access (${JSON.stringify(outcome)})`,
  );
  assert(
    outcome.fetchOutcome?.kind !== 'response' ||
      outcome.fetchOutcome.status !== 200,
    `opaque artifact retained direct shell HTTP authority (${JSON.stringify(outcome)})`,
  );
  assert(
    outcome.websocketOutcome?.kind !== 'opened',
    `opaque artifact retained direct shell websocket authority (${JSON.stringify(outcome)})`,
  );
}

async function runArtifactFlow(page, harness) {
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(ARTIFACT_PROMPT);
  await page.getByRole('button', { name: '보내기' }).click();

  const artifactChip = page
    .locator('.artifact-reference-chip')
    .filter({ hasText: 'markdown · v1' });
  const artifactSurface = page.locator('.artifact-editor-surface');
  await artifactChip.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .getByRole('button', { name: '중단' })
    .waitFor({ state: 'hidden', timeout: 15_000 });
  await waitForTranscriptMarkerCount(page, [
    { text: ARTIFACT_PROMPT, count: 1 },
  ]);
  await artifactChip.click();
  await artifactSurface.waitFor({ state: 'visible', timeout: 15_000 });
  await artifactSurface
    .locator('.artifact-editor-meta')
    .filter({ hasText: 'markdown · v1' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .getByText(ARTIFACT_PREVIEW_MARKER, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });

  await artifactSurface.getByTitle('원문 보기').click();
  const artifactSource = artifactSurface.getByLabel('아티팩트 원문', {
    exact: true,
  });
  await artifactSource.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await artifactSource.inputValue()) === ARTIFACT_PAYLOAD,
    'artifact source mode did not expose the exact committed payload',
  );
  await artifactSurface.getByTitle('프리뷰').click();
  await page
    .getByText(ARTIFACT_PREVIEW_MARKER, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });

  await artifactSurface.getByRole('button', { name: '아티팩트 닫기' }).click();
  await artifactSurface.waitFor({ state: 'hidden', timeout: 15_000 });
  await artifactChip.click();
  await artifactSurface.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await harness.readArtifactRequestCount()) === 1,
    'artifact vertical did not dispatch exactly one provider request',
  );

  const settledTranscript =
    (await page.locator('[aria-label="Assistant transcript"]').textContent()) ??
    '';
  assert(
    !settledTranscript.includes('GEULBAT_ARTIFACT'),
    'artifact compatibility envelope leaked into the visible transcript',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: ARTIFACT_PROMPT });
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedThread.click();

  const persistedChip = page
    .locator('.artifact-reference-chip')
    .filter({ hasText: 'markdown · v1' });
  await persistedChip.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await page.locator('.artifact-reference-chip').count()) === 1,
    'reloaded artifact transcript did not preserve exactly one reference chip',
  );
  await persistedChip.click();
  await artifactSurface.waitFor({ state: 'visible', timeout: 15_000 });
  await artifactSurface.getByTitle('원문 보기').click();
  await artifactSource.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await artifactSource.inputValue()) === ARTIFACT_PAYLOAD,
    'reloaded artifact surface did not preserve the exact committed payload',
  );
  await waitForTranscriptMarkerCount(page, [
    { text: ARTIFACT_PROMPT, count: 1 },
  ]);
  assert(
    (await harness.readArtifactRequestCount()) === 1,
    'artifact reload dispatched an unexpected provider request',
  );
}

async function runSubagentFlow(page, harness) {
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(SUBAGENT_PARENT_PROMPT);
  await page.getByRole('button', { name: '보내기' }).click();

  const subagentCard = page
    .locator('.subagent-work-card')
    .filter({ hasText: 'explorer' });
  await subagentCard
    .filter({ hasText: '모델 응답 대기' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await waitForTranscriptMarkerCount(page, [
    { text: SUBAGENT_PARENT_PROMPT, count: 1 },
    { text: SUBAGENT_FINAL_TEXT, count: 1 },
  ]);
  await page
    .getByRole('button', { name: '중단' })
    .waitFor({ state: 'hidden', timeout: 15_000 });

  await subagentCard.locator('summary').click();
  await subagentCard
    .locator('.subagent-work-detail')
    .filter({ hasText: '진행: 모델 응답 대기' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await subagentCard.getByRole('button', { name: '트랜스크립트 보기' }).click();
  const childDialog = page.getByRole('dialog', { name: '보조 작업 세션' });
  await childDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await childDialog
    .getByText(SUBAGENT_CHILD_TASK, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await childDialog.getByRole('button', { name: '닫기' }).click();
  await childDialog.waitFor({ state: 'hidden', timeout: 15_000 });

  const runningState = await harness.readSubagentState();
  assert(
    runningState.parentRequestCount === 2 &&
      runningState.childRequestCount === 1,
    'subagent vertical did not dispatch two parent rounds and one child request',
  );
  await subagentCard.getByRole('button', { name: '중지' }).click();
  await subagentCard
    .filter({ hasText: 'explorer 작업 취소됨' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  if ((await subagentCard.getAttribute('open')) === null) {
    await subagentCard.locator('summary').click();
  }
  await subagentCard
    .locator('.subagent-work-detail')
    .filter({ hasText: '종료 원인: 명시적 중지' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await subagentCard.getByRole('button', { name: '중지' }).count()) === 0,
    'terminal subagent card retained a stale stop control',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: SUBAGENT_PARENT_PROMPT });
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedThread.click();

  const persistedCard = page
    .locator('.subagent-work-card')
    .filter({ hasText: 'explorer 작업 취소됨' });
  await persistedCard.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedCard.locator('summary').click();
  await persistedCard
    .getByRole('button', { name: '트랜스크립트 보기' })
    .click();
  await childDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await childDialog
    .getByText(SUBAGENT_CHILD_TASK, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await childDialog.getByRole('button', { name: '닫기' }).click();
  await waitForTranscriptMarkerCount(page, [
    { text: SUBAGENT_PARENT_PROMPT, count: 1 },
    { text: SUBAGENT_FINAL_TEXT, count: 1 },
  ]);
  const reloadedState = await harness.readSubagentState();
  assert(
    reloadedState.parentRequestCount === 2 &&
      reloadedState.childRequestCount === 1,
    'subagent reload dispatched an unexpected provider request',
  );
}

// 각 흐름: 갓 mount된 페이지 하나에서 실행되며, 예외를 던지면 실패로 기록된다.
const flows = [
  {
    name: 'app-loads-and-daemon-connected',
    // 앱이 mount되고 데몬 연결 표시등이 켜지는가 (인증 + 웹소켓 배선).
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page
        .locator('textarea[name="assistant-message"]')
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page
        .locator('.assistant-title-dot.connected')
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
  },
  {
    name: 'file-browser-navigates-via-daemon',
    // 컴퓨터 파일 트리 탐색이 데몬까지 왕복하는가 (브레드크럼 이동 → tree fetch).
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/api/files/tree') && r.status() === 200,
          { timeout: 8_000 },
        ),
        page.locator('[aria-label^="경로로 이동:"]').first().click(),
      ]);
      assert(
        response.ok(),
        '브레드크럼 이동이 데몬 tree fetch를 트리거하지 않음',
      );
    },
  },
  {
    name: 'composer-model-menu-opens',
    // 컴포저 모델/사고강도/속도 메뉴가 열리는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const pill = page.locator(
        '.composer-pill[title="모델, 사고 강도와 속도"]',
      );
      await pill.waitFor({ state: 'visible', timeout: 15_000 });
      await pill.click();
      await page
        .locator('.composer-menu')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
  {
    name: 'working-directory-picker-opens',
    // 시작 위치(워킹디렉터리) 선택 오버레이가 열리는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const contextBar = page.locator('.composer-context-bar');
      await contextBar.waitFor({ state: 'visible', timeout: 15_000 });
      await contextBar.click();
      await page
        .locator('[role="dialog"]')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
  {
    name: 'session-mode-shows-thread-list',
    // 좌측 패널을 세션(스레드) 모드로 전환하면 스레드 목록 패널이 뜨는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const toggle = page.locator('.pref-toggle', { hasText: '세션' });
      await toggle.waitFor({ state: 'visible', timeout: 15_000 });
      await toggle.click();
      await page
        .locator('.sessions-pane')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
  {
    name: 'composer-permission-menu-opens',
    // 컴포저 권한 방식 메뉴가 열리는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const pill = page.getByRole('button', { name: /승인/u });
      await pill.waitFor({ state: 'visible', timeout: 15_000 });
      await pill.click();
      await page
        .locator('.composer-menu')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
  {
    name: 'composer-attach-menu-opens',
    // 컴포저 첨부/도구([+]) 메뉴가 열리는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const pill = page.locator('.composer-pill[title="첨부와 도구"]');
      await pill.waitFor({ state: 'visible', timeout: 15_000 });
      await pill.click();
      await page
        .locator('.composer-menu')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
  {
    name: 'plugin-marketplace-opens',
    // 플러그인 마켓 패널이 데몬에서 로드되어 뜨는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const entry = page.locator('.settings-entry', { hasText: '플러그인' });
      await entry.waitFor({ state: 'visible', timeout: 15_000 });
      await entry.click();
      // 허브 크롬의 새로고침 버튼(고유) — 마켓 아이템 수에 의존하지 않는다.
      await page
        .locator('[aria-label="플러그인 새로고침"]')
        .waitFor({ state: 'visible', timeout: 8_000 });
    },
  },
  {
    name: 'layout-menu-opens',
    // 배치(탐색기·에디터·채팅) 전환 메뉴가 열리는가.
    async run(page, appUrl) {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const anchor = page.locator('.layout-menu-anchor');
      await anchor.waitFor({ state: 'attached', timeout: 15_000 });
      await anchor.click();
      await page
        .locator('.layout-menu[role="menu"]')
        .waitFor({ state: 'visible', timeout: 6_000 });
    },
  },
];

async function executeBrowserFlow(browser, name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 120)));
  const startedAt = performance.now();
  try {
    const evidence = await run(page);
    return {
      name,
      ok: true,
      ms: performance.now() - startedAt,
      ...(evidence === undefined ? {} : { evidence }),
    };
  } catch (error) {
    await page
      .screenshot({ path: path.join(screenshotDir, `${name}.png`) })
      .catch(() => {});
    return {
      name,
      ok: false,
      ms: performance.now() - startedAt,
      error: String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 160),
      pageErrors: pageErrors.slice(0, 3),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const abortController = new AbortController();
  let browser;
  let browserClosing;
  let harness;
  let harnessClosing;
  let stopSignal;
  const results = [];

  const closeRuntime = async () => {
    const closeResults = await Promise.allSettled([
      browser === undefined
        ? Promise.resolve()
        : (browserClosing ??= browser.close()),
      harness === undefined
        ? Promise.resolve()
        : (harnessClosing ??= harness.close()),
    ]);
    const closeFailures = closeResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, 'flow-gate cleanup failed');
    }
  };

  const stop = (signal) => {
    if (stopSignal !== undefined) {
      return;
    }
    stopSignal = signal;
    abortController.abort(new Error(`flow-gate interrupted by ${signal}`));
    void closeRuntime().catch((error) => {
      console.error('flow-gate signal cleanup failed', error);
    });
  };
  const signalHandlers = [
    ['SIGINT', () => stop('SIGINT')],
    ['SIGTERM', () => stop('SIGTERM')],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  try {
    await fs.mkdir(screenshotDir, { recursive: true });
    abortController.signal.throwIfAborted();
    harness = await createIsolatedFlowGateHarness({
      signal: abortController.signal,
    });
    abortController.signal.throwIfAborted();
    await preflight(harness.appUrl);
    abortController.signal.throwIfAborted();
    const env = await resolveChromiumLaunchEnv({ repoRoot });
    abortController.signal.throwIfAborted();
    browser = await chromium.launch({ headless: true, env });
    abortController.signal.throwIfAborted();
    const browserVersion = browser.version();
    const reconnectRecoveryResult = await executeBrowserFlow(
      browser,
      'reconnect-replays-buffered-daemon-output-once',
      async (page) => {
        let browserEvidence;
        try {
          browserEvidence = await runReconnectReplayRecoveryFlow(page, harness);
        } finally {
          await harness.finishRecovery();
        }
        return {
          browser: browserEvidence,
          daemon: await harness.readHotPathMetrics(browserEvidence.runId),
        };
      },
    );
    results.push(reconnectRecoveryResult);
    const runSettlementResult = await executeBrowserFlow(
      browser,
      'run-start-streams-and-settles-durably',
      (page) => runStartAndSettlementFlow(page, harness),
    );
    results.push(runSettlementResult);
    results.push(
      await executeBrowserFlow(
        browser,
        'approval-pauses-write-and-resumes-through-real-tool-boundary',
        (page) => runApprovalFlow(page, harness),
      ),
    );
    results.push(
      await executeBrowserFlow(
        browser,
        'artifact-frame-is-opaque-and-cannot-inherit-shell-authority',
        (page) => runArtifactOpaqueOriginIsolationFlow(page, harness),
      ),
    );
    results.push(
      await executeBrowserFlow(
        browser,
        'artifact-commits-opens-controls-and-reloads-durably',
        (page) => runArtifactFlow(page, harness),
      ),
    );
    results.push(
      await executeBrowserFlow(
        browser,
        'subagent-observes-stops-and-reloads-durably',
        (page) => runSubagentFlow(page, harness),
      ),
    );
    for (const flow of flows) {
      results.push(
        await executeBrowserFlow(browser, flow.name, (page) =>
          flow.run(page, harness.appUrl),
        ),
      );
    }
    if (
      hotPathOutputPath !== undefined &&
      reconnectRecoveryResult.ok &&
      reconnectRecoveryResult.evidence !== undefined &&
      runSettlementResult.ok &&
      runSettlementResult.evidence !== undefined
    ) {
      await writePrivatePerformanceReport(
        path.resolve(repoRoot, hotPathOutputPath),
        buildFlowGateHotPathReport({
          environment: collectBrowserPerformanceEnvironment({
            repoRoot,
            browserVersion,
          }),
          reconnectRecovery: reconnectRecoveryResult.evidence,
          runSettlement: runSettlementResult.evidence,
        }),
      );
    }
  } catch (error) {
    if (stopSignal === undefined) {
      throw error;
    }
  } finally {
    try {
      await closeRuntime();
    } finally {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    }
  }

  if (stopSignal !== undefined) {
    const signalNumber = os.constants.signals[stopSignal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  }

  for (const result of results) {
    const detail = result.ok
      ? ''
      : `\n      → ${result.error}${
          result.pageErrors.length
            ? ` | pageerror: ${result.pageErrors.join(' ; ')}`
            : ''
        }`;
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${result.ms}ms)${detail}`,
    );
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} flows passed`);
  return passed === results.length ? 0 : 1;
}

process.exitCode = await main();
