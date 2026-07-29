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
import { createHash, randomBytes } from 'node:crypto';
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
import { buildFlowGateUserVisiblePerformanceSample } from './flow-gate-user-visible-performance-report.mjs';
import { writePrivatePerformanceReport } from '../../../scripts/performance-report-support.mjs';
import { collectBrowserPerformanceEnvironment } from './performance-report-support.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const screenshotDir = path.join(repoRoot, 'output', 'playwright', 'flow-gate');
const hotPathOutputPath = readStringOption('--hot-path-output');
const restartEvidenceOutputPath = readStringOption('--restart-evidence-output');
const userVisiblePerformanceOutputPath = readStringOption(
  '--user-visible-performance-output',
);
const INITIAL_RECOVERY_COMMENTARY =
  'flow-gate: output visible before disconnect';
const BUFFERED_RECOVERY_COMMENTARY =
  'flow-gate: output buffered while disconnected';
const RECOVERY_THREAD_TITLE = 'Flow gate reconnect recovery';
const RUN_SETTLEMENT_PROMPT = 'flow-gate run start and settlement proof';
const RUN_STREAM_PREFIX = 'flow-gate: streamed-before-settlement';
const RUN_FINAL_SUFFIX = '::durably-settled';
const RUN_FINAL_TEXT = `${RUN_STREAM_PREFIX}${RUN_FINAL_SUFFIX}`;
const PLAN_STEER_PROMPT = 'flow-gate plan steer preservation proof';
const PLAN_STEER_TEXT = 'flow-gate: keep the plan while steering';
const PLAN_STEER_STEP = 'flow-gate plan remains visible';
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
const DEFAULT_DIRECTORY_NAME = 'default-alpha';
const RECENT_DIRECTORY_NAME = 'recent-target';
const RECENT_DIRECTORY_CHILD_NAMES = ['recent-child-a', 'recent-child-b'];
const IMAGE_FILE_NAME = 'flow-gate-image.png';
const VIDEO_FILE_NAME = 'flow-gate-video.mp4';
const IMAGE_FILE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const VIDEO_FILE_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHZIAAB2SAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALFAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOlAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAv1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiRsQr/+wAAAAAhBnkJ4hf/BgQAAAAgBnmF0Qr/EgAAAAAgBnmNqQr/EgQ==';
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
  let defaultDirectory;
  let devToken;
  let providerAuthFilePath;
  let recentDirectory;
  let spawnDaemon;
  let temporaryRoot;
  let workspaceRoot;
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
    providerAuthFilePath = path.join(temporaryRoot, 'provider-auth.json');
    workspaceRoot = path.join(temporaryRoot, 'workspace');
    defaultDirectory = path.join(workspaceRoot, DEFAULT_DIRECTORY_NAME);
    recentDirectory = path.join(workspaceRoot, RECENT_DIRECTORY_NAME);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await Promise.all([
      fs.mkdir(defaultDirectory, { recursive: true }),
      ...RECENT_DIRECTORY_CHILD_NAMES.map((name) =>
        fs.mkdir(path.join(recentDirectory, name), { recursive: true }),
      ),
      fs.writeFile(
        path.join(workspaceRoot, IMAGE_FILE_NAME),
        Buffer.from(IMAGE_FILE_BASE64, 'base64'),
      ),
      fs.writeFile(
        path.join(workspaceRoot, VIDEO_FILE_NAME),
        Buffer.from(VIDEO_FILE_BASE64, 'base64'),
      ),
    ]);
    approvalTargetPath = path.join(temporaryRoot, 'approved-write.txt');
    devToken = randomBytes(32).toString('hex');
    const daemonPort = await reserveFreePort();
    signal?.throwIfAborted();
    daemonOrigin = `http://127.0.0.1:${daemonPort}`;
    // 데몬이 화면까지 서빙한다. 게이트는 제품과 같은 단일 origin 위상을
    // 검증해야 하므로 별도 dev server 포트를 두지 않는다.
    appUrl = `${daemonOrigin}/`;
    spawnDaemon = () =>
      spawnCapturedProcess(
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
            GEULBAT_FLOW_GATE_PLAN_STEER_PROMPT: PLAN_STEER_PROMPT,
            GEULBAT_FLOW_GATE_PLAN_STEER_STEP: PLAN_STEER_STEP,
            GEULBAT_FLOW_GATE_RUN_FINAL_SUFFIX: RUN_FINAL_SUFFIX,
            GEULBAT_FLOW_GATE_RUN_SETTLEMENT_PROMPT: RUN_SETTLEMENT_PROMPT,
            GEULBAT_FLOW_GATE_RUN_STREAM_PREFIX: RUN_STREAM_PREFIX,
            GEULBAT_FLOW_GATE_SUBAGENT_CHILD_TASK: SUBAGENT_CHILD_TASK,
            GEULBAT_FLOW_GATE_SUBAGENT_FINAL_TEXT: SUBAGENT_FINAL_TEXT,
            GEULBAT_FLOW_GATE_SUBAGENT_PARENT_PROMPT: SUBAGENT_PARENT_PROMPT,
            GEULBAT_FLOW_GATE_THREAD_TITLE: RECOVERY_THREAD_TITLE,
            GEULBAT_FLOW_GATE_WORKING_DIRECTORY: workspaceRoot,
            GEULBAT_FLOW_GATE_SHELL_ASSET_ROOT: path.join(
              repoRoot,
              'apps',
              'web-shell',
              'dist',
            ),
            GEULBAT_HOME_STATE_ROOT: homeStateRoot,
            GEULBAT_LLM_PROVIDER: 'openai_codex_direct',
            GEULBAT_PROVIDER_AUTH_FILE_PATH: providerAuthFilePath,
            GEULBAT_REPO_ROOT: repoRoot,
            HOST: '127.0.0.1',
            PORT: String(daemonPort),
          },
        },
        daemonLogs,
      );
    daemon = spawnDaemon();
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
    workspace: {
      root: workspaceRoot,
      defaultDirectory,
      recentDirectory,
      imageFile: path.join(workspaceRoot, IMAGE_FILE_NAME),
      videoFile: path.join(workspaceRoot, VIDEO_FILE_NAME),
    },
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
    async readProviderAuthPersistence() {
      const [content, metadata] = await Promise.all([
        fs.readFile(providerAuthFilePath),
        fs.stat(providerAuthFilePath),
      ]);
      return {
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        mtimeMs: metadata.mtimeMs,
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
    async prepareRestartMedia() {
      const payload = await requestFixture('/api/flow-gate/media/prepare', {});
      assert(
        typeof payload.threadId === 'string' &&
          typeof payload.mediaRef === 'string' &&
          typeof payload.expectedText === 'string',
        'media restart fixture returned malformed evidence',
      );
      return {
        threadId: payload.threadId,
        mediaRef: payload.mediaRef,
        expectedText: payload.expectedText,
      };
    },
    async restartDaemon() {
      signal?.throwIfAborted();
      assert(daemon !== undefined, 'flow-gate daemon was not started');
      assert(
        spawnDaemon !== undefined,
        'flow-gate daemon spawn owner is absent',
      );
      const beforePid = daemon.pid;
      assert(
        typeof beforePid === 'number',
        'flow-gate daemon did not expose a process id',
      );
      const crashed = new Promise((resolve) => {
        daemon.once('exit', (code, exitSignal) => {
          resolve({ code, signal: exitSignal });
        });
      });
      assert(
        daemon.kill('SIGKILL'),
        'flow-gate daemon rejected the requested crash signal',
      );
      const crash = await crashed;
      signal?.throwIfAborted();
      daemon = spawnDaemon();
      await waitForDaemonReady(`${daemonOrigin}/api/health`, daemonLogs, {
        signal,
      });
      const afterPid = daemon.pid;
      assert(
        typeof afterPid === 'number' && afterPid !== beforePid,
        'flow-gate replacement daemon did not receive a fresh process id',
      );
      return { beforePid, afterPid, crash };
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

async function waitForContextBarPath(page, expectedPath, stage) {
  const expectedTitle = `시작 위치: ${expectedPath}`;
  try {
    await page.waitForFunction(
      (title) =>
        document
          .querySelector('.composer-context-bar')
          ?.getAttribute('title') === title,
      expectedTitle,
      { timeout: 8_000 },
    );
  } catch (error) {
    const actualTitle = await page
      .locator('.composer-context-bar')
      .getAttribute('title')
      .catch(() => null);
    throw new Error(
      `${stage} cwd did not converge: expected ${expectedTitle}, received ${String(actualTitle)}`,
      { cause: error },
    );
  }
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
  const cancelRun = page.getByRole('button', { name: '중단' });
  await cancelRun.waitFor({ state: 'visible', timeout: 15_000 });

  const context = page.context();
  let browserHeldOffline = false;
  let activeRunControlStayedVisible = false;
  let reconnectAvailableAt;
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
      activeRunControlStayedVisible = await cancelRun.isVisible();
      reconnectAvailableAt = performance.now();
      await context.setOffline(false);
    }
  }

  assert(
    reconnectAvailableAt !== undefined,
    'reconnect measurement did not observe the browser returning online',
  );
  const [connectedMs, transcriptVisibleMs, activeRunControlVisibleMs] =
    await Promise.all([
      connected
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => performance.now() - reconnectAvailableAt),
      waitForTranscriptMarkerCount(page, [
        { text: INITIAL_RECOVERY_COMMENTARY, count: 1 },
        { text: BUFFERED_RECOVERY_COMMENTARY, count: 1 },
      ]).then(() => performance.now() - reconnectAvailableAt),
      cancelRun
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => performance.now() - reconnectAvailableAt),
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
  return {
    ...runEventFrames.readSingleRun(),
    userVisible: {
      connectedMs,
      transcriptVisibleMs,
      activeRunControlVisibleMs,
      activeRunControlStayedVisible,
    },
  };
}

async function runStartAndSettlementFlow(page, harness) {
  const runEventFrames = observeFlowGateRunEventFrames(page);
  const selectedComputerPath = path.relative(
    path.parse(harness.workspace.recentDirectory).root,
    harness.workspace.recentDirectory,
  );
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  const approvalMode = page.locator('.composer-pill[title="승인 방식"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await approvalMode
    .filter({ hasText: '수동 승인' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  await approvalMode.click();
  await page
    .getByRole('menuitem')
    .filter({ hasText: '모든 승인 건너뛰기' })
    .click();
  await approvalMode
    .filter({ hasText: '승인 건너뛰기' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  await page
    .locator('[role="treeitem"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  const contextBar = page.locator('.composer-context-bar');
  await contextBar.waitFor({ state: 'visible', timeout: 15_000 });
  await contextBar.click();
  const workingDirectoryDialog = page.getByRole('dialog', {
    name: '시작 위치 선택',
  });
  await workingDirectoryDialog.waitFor({ state: 'visible', timeout: 8_000 });
  await workingDirectoryDialog
    .getByRole('button', {
      name: `폴더 열기: ${RECENT_DIRECTORY_NAME}`,
    })
    .click();
  const preferenceResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/files/directory-preferences' &&
      response.request().method() === 'POST' &&
      response.status() === 200,
    { timeout: 8_000 },
  );
  const existingSelectionStartedAt = performance.now();
  await workingDirectoryDialog
    .getByRole('button', { name: '이 폴더 사용' })
    .click();
  await workingDirectoryDialog.waitFor({ state: 'hidden', timeout: 8_000 });
  await waitForContextBarPath(page, selectedComputerPath, 'existing selection');
  const existingSelectionMs = performance.now() - existingSelectionStartedAt;
  await preferenceResponse;
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
  await approvalMode
    .filter({ hasText: '수동 승인' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  await page.getByRole('button', { name: '새 세션' }).click();
  await waitForContextBarPath(
    page,
    harness.workspace.root,
    'new-session setup',
  );
  await approvalMode
    .filter({ hasText: '수동 승인' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: RUN_SETTLEMENT_PROMPT });
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  const existingRestoreStartedAt = performance.now();
  await persistedThread.click();
  await waitForContextBarPath(page, selectedComputerPath, 'existing restore');
  await approvalMode
    .filter({ hasText: '승인 건너뛰기' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  const existingRestoreMs = performance.now() - existingRestoreStartedAt;
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
  const newSessionResetStartedAt = performance.now();
  await page.getByRole('button', { name: '새 세션' }).click();
  await waitForContextBarPath(
    page,
    harness.workspace.root,
    'new-session reset',
  );
  await approvalMode
    .filter({ hasText: '수동 승인' })
    .waitFor({ state: 'visible', timeout: 8_000 });
  const newSessionResetMs = performance.now() - newSessionResetStartedAt;
  const browser = runEventFrames.readSingleRun();
  return {
    browser,
    daemon: await harness.readHotPathMetrics(browser.runId),
    provider,
    userVisible: {
      cwd: {
        existingSelectionMs,
        existingRestoreMs,
        newSessionResetMs,
        selectedPath: selectedComputerPath,
        newSessionPath: harness.workspace.root,
        approvalMode: {
          shellDefault: 'basic',
          restoredThread: 'full_access',
          newSession: 'basic',
        },
      },
    },
  };
}

async function runPlanSteerFlow(page, harness) {
  await page.goto(harness.appUrl, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('textarea[name="assistant-message"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(PLAN_STEER_PROMPT);
  await page.getByRole('button', { name: '보내기' }).click();

  const planCard = page
    .locator('.run-plan-card')
    .filter({ hasText: PLAN_STEER_STEP });
  const cancelRun = page.getByRole('button', { name: '중단' });
  await planCard.waitFor({ state: 'visible', timeout: 15_000 });
  await cancelRun.waitFor({ state: 'visible', timeout: 15_000 });

  await composer.fill(PLAN_STEER_TEXT);
  await page.getByRole('button', { name: '보내기' }).click();
  const pendingSteer = page
    .locator('.pending-steer-message')
    .filter({ hasText: PLAN_STEER_TEXT });
  await pendingSteer.waitFor({ state: 'visible', timeout: 15_000 });
  await planCard.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    ((await planCard.textContent()) ?? '').includes(PLAN_STEER_STEP),
    'queued steer removed the visible in-progress plan',
  );

  await cancelRun.click();
  await cancelRun.waitFor({ state: 'hidden', timeout: 15_000 });
  return {
    planStep: PLAN_STEER_STEP,
    steerText: PLAN_STEER_TEXT,
    preservedWhileQueued: true,
    cancelledExplicitly: true,
  };
}

async function selectPersistedThread(page, prompt) {
  const persistedThread = page
    .locator('.thread-row > div > button')
    .filter({ hasText: prompt });
  if (!(await persistedThread.isVisible())) {
    await page.locator('.pref-toggle', { hasText: '세션' }).click();
  }
  await persistedThread.waitFor({ state: 'visible', timeout: 15_000 });
  await persistedThread.click();
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
  const media = await harness.prepareRestartMedia();
  const providerAuthBeforeRestart = await harness.readProviderAuthPersistence();
  const restart = await harness.restartDaemon();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  const providerAuthAfterRestart = await harness.readProviderAuthPersistence();
  assert(
    providerAuthAfterRestart.bytes === providerAuthBeforeRestart.bytes &&
      providerAuthAfterRestart.sha256 === providerAuthBeforeRestart.sha256 &&
      providerAuthAfterRestart.mtimeMs === providerAuthBeforeRestart.mtimeMs,
    'replacement daemon rewrote or lost the persisted provider credential',
  );
  const providerAuthStatus = await page.evaluate(async () => {
    const response = await fetch(
      '/api/provider-auth/status?providerId=openai_codex_direct',
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  });
  assert(
    providerAuthStatus.status === 200 &&
      providerAuthStatus.body?.state === 'ready' &&
      providerAuthStatus.body?.ready === true,
    'replacement daemon did not hydrate the persisted provider credential',
  );
  await page.locator('.pref-toggle', { hasText: '세션' }).click();
  const pendingThread = page
    .locator('.thread-row')
    .filter({ hasText: 'New Thread' })
    .filter({ hasText: '1 messages' });
  await pendingThread.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await pendingThread.count()) === 1,
    'replacement daemon did not expose exactly one pending-run thread',
  );
  await pendingThread.locator('button').first().click();
  await approvalDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await cancelRun.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    ((await approvalDialog.textContent()) ?? '').includes(
      harness.approvalTargetPath,
    ),
    'replacement daemon did not restore the exact pending approval target',
  );
  const restoredApproval = await harness.readApprovalState();
  assert(
    restoredApproval.exists === false &&
      restoredApproval.matchesExpectedContent === false,
    'replacement daemon applied the pending write before renewed approval',
  );
  assert(
    restoredApproval.providerRequestCount === 0,
    'replacement daemon redispatched the provider before resolving the durable approval',
  );

  const rangeStart = 5;
  const rangeEnd = 22;
  const mediaUrl = new URL(
    `/api/threads/${media.threadId}/media/${media.mediaRef}`,
    harness.appUrl,
  ).toString();
  const mediaRange = await page.evaluate(
    async ({ url, start, end }) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        body: await response.text(),
      };
    },
    { url: mediaUrl, start: rangeStart, end: rangeEnd },
  );
  assert(
    mediaRange.status === 206 &&
      mediaRange.contentRange ===
        `bytes ${rangeStart}-${rangeEnd}/${media.expectedText.length}` &&
      mediaRange.body === media.expectedText.slice(rangeStart, rangeEnd + 1),
    'replacement daemon did not serve the authenticated durable media byte range',
  );
  const mediaDownload = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      body: await response.text(),
    };
  }, mediaUrl);
  assert(
    mediaDownload.status === 200 && mediaDownload.body === media.expectedText,
    'replacement daemon did not serve the complete authenticated durable media download',
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
    afterApproval.providerRequestCount === 1,
    `replacement approval vertical dispatched ${String(
      afterApproval.providerRequestCount,
    )} provider requests instead of one final round`,
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('.assistant-title-dot.connected')
    .waitFor({ state: 'visible', timeout: 15_000 });
  await selectPersistedThread(page, APPROVAL_PROMPT);
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

  await selectPersistedThread(page, ARTIFACT_PROMPT);
  const persistedArtifactChip = page
    .locator('.artifact-reference-chip')
    .filter({ hasText: 'markdown · v1' });
  await persistedArtifactChip.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await page.locator('.artifact-reference-chip').count()) === 1,
    'replacement daemon did not restore exactly one committed artifact reference',
  );
  await persistedArtifactChip.click();
  const artifactSurface = page.locator('.artifact-editor-surface');
  await artifactSurface.waitFor({ state: 'visible', timeout: 15_000 });
  await artifactSurface.getByTitle('원문 보기').click();
  const artifactSource = artifactSurface.getByLabel('아티팩트 원문', {
    exact: true,
  });
  await artifactSource.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await artifactSource.inputValue()) === ARTIFACT_PAYLOAD,
    'replacement daemon did not restore the exact committed artifact payload',
  );
  await artifactSurface.getByRole('button', { name: '아티팩트 닫기' }).click();

  await selectPersistedThread(page, SUBAGENT_PARENT_PROMPT);
  const persistedChild = page
    .locator('.subagent-work-card')
    .filter({ hasText: 'explorer 작업 취소됨' });
  await persistedChild.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await persistedChild.getAttribute('open')) === null) {
    await persistedChild.locator('summary').click();
  }
  await persistedChild
    .locator('.subagent-work-detail')
    .filter({ hasText: '종료 원인: 명시적 중지' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await persistedChild.getByRole('button', { name: '중지' }).count()) === 0,
    'replacement daemon restored a stale control for the terminal child',
  );

  return {
    daemon: restart,
    approval: {
      beforeRestartProviderRequestCount: beforeApproval.providerRequestCount,
      afterRestartProviderRequestCount: restoredApproval.providerRequestCount,
      finalProviderRequestCount: afterApproval.providerRequestCount,
    },
    providerAuth: {
      beforeRestart: providerAuthBeforeRestart,
      afterRestart: providerAuthAfterRestart,
      status: providerAuthStatus.body.state,
      ready: providerAuthStatus.body.ready,
    },
    media: {
      mediaRef: media.mediaRef,
      sameOrigin: new URL(mediaUrl).origin === new URL(harness.appUrl).origin,
      status: mediaRange.status,
      contentRange: mediaRange.contentRange,
      downloadStatus: mediaDownload.status,
      downloadBytes: Buffer.byteLength(mediaDownload.body),
    },
    restored: {
      activeRun: true,
      approval: true,
      artifact: true,
      childTerminalStatus: true,
      media: true,
      providerAuth: true,
    },
  };
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
  const artifactOpenStartedAt = performance.now();
  await artifactChip.click();
  await artifactSurface.waitFor({ state: 'visible', timeout: 15_000 });
  const panelOpenMs = performance.now() - artifactOpenStartedAt;
  await artifactSurface
    .locator('.artifact-editor-meta')
    .filter({ hasText: 'markdown · v1' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .getByText(ARTIFACT_PREVIEW_MARKER, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  const firstContentMs = performance.now() - artifactOpenStartedAt;

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
  return {
    userVisible: {
      panelOpenMs,
      firstContentMs,
    },
  };
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

async function measureDirectoryLocation(page, dialog, args) {
  const list = dialog.getByLabel('하위 폴더');
  let responseFailure;
  const responsePromise = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/files/tree' &&
        response.status() === 200,
      { timeout: 8_000 },
    )
    .catch((error) => {
      responseFailure = error;
      return null;
    });
  const startedAt = performance.now();
  try {
    await dialog.getByTitle(args.path, { exact: true }).click();
  } catch (error) {
    const locationTitles = await dialog
      .locator('.computer-directory-picker-locations button[title]')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('title')),
      );
    throw new Error(
      `${args.label} directory location was not selectable: expected ${args.path}; available ${JSON.stringify(locationTitles)}`,
      { cause: error },
    );
  }
  await list
    .getByRole('button', {
      name: `폴더 열기: ${args.firstDirectoryName}`,
    })
    .waitFor({ state: 'visible', timeout: 8_000 });
  const firstResultMs = performance.now() - startedAt;
  const response = await responsePromise;
  if (responseFailure !== undefined) {
    throw responseFailure;
  }
  assert(
    response !== null && response.ok(),
    `${args.label} directory request did not succeed`,
  );
  await page.waitForFunction((expectedNames) => {
    const labels = [
      ...document.querySelectorAll(
        '.computer-directory-picker-list button[aria-label^="폴더 열기:"]',
      ),
    ].map((element) => element.getAttribute('aria-label'));
    return (
      labels.length === expectedNames.length &&
      expectedNames.every((name) => labels.includes(`폴더 열기: ${name}`))
    );
  }, args.directoryNames);
  return {
    firstResultMs,
    completeMs: performance.now() - startedAt,
    resultCount: args.directoryNames.length,
  };
}

async function measureBinaryPreview(page, args) {
  const treeItem = page
    .locator('[role="treeitem"]')
    .filter({ hasText: args.fileName });
  await treeItem.waitFor({ state: 'visible', timeout: 15_000 });
  const startedAt = performance.now();
  await treeItem.click();
  const media =
    args.kind === 'image'
      ? page.locator('img.binary-preview-image')
      : page.locator('video.binary-preview-video');
  await media.waitFor({ state: 'visible', timeout: 15_000 });
  const panelOpenMs = performance.now() - startedAt;
  if (args.kind === 'video') {
    await media.evaluate((element) => {
      element.preload = 'auto';
      element.load();
    });
  }
  await page.waitForFunction(
    ({ kind }) => {
      if (kind === 'image') {
        const image = document.querySelector('img.binary-preview-image');
        return (
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0
        );
      }
      const video = document.querySelector('video.binary-preview-video');
      return (
        video instanceof HTMLVideoElement &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0
      );
    },
    { kind: args.kind },
  );
  const renderedPath =
    args.kind === 'image' ? await media.getAttribute('alt') : args.path;
  const sourceUrl = await media.getAttribute('src');
  assert(
    sourceUrl !== null &&
      new URL(sourceUrl, args.appUrl).origin === new URL(args.appUrl).origin,
    `${args.kind} preview did not use the app origin`,
  );
  return {
    panelOpenMs,
    firstFrameMs: performance.now() - startedAt,
    path: renderedPath ?? args.path,
    sourceOrigin: new URL(sourceUrl, args.appUrl).origin,
    ...(args.kind === 'video' ? { decodeTrigger: 'preload_auto' } : {}),
  };
}

// 각 흐름: 갓 mount된 페이지 하나에서 실행되며, 예외를 던지면 실패로 기록된다.
const flows = [
  {
    name: 'app-loads-and-daemon-connected',
    // 앱이 mount되고 데몬 연결 표시등이 켜지는가 (인증 + 웹소켓 배선).
    async run(page, appUrl) {
      const startedAt = performance.now();
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const composer = page.locator('textarea[name="assistant-message"]');
      await composer.waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForFunction(() => {
        const input = document.querySelector(
          'textarea[name="assistant-message"]',
        );
        return (
          input instanceof HTMLTextAreaElement &&
          !input.disabled &&
          !input.readOnly
        );
      });
      const composerEditableMs = performance.now() - startedAt;
      await page
        .locator('.assistant-title-dot.connected')
        .waitFor({ state: 'visible', timeout: 15_000 });
      return { userVisible: { composerEditableMs } };
    },
  },
  {
    name: 'file-browser-navigates-via-daemon',
    // 컴퓨터 파일 트리 탐색이 데몬까지 왕복하는가 (브레드크럼 이동 → tree fetch).
    async run(page, appUrl, harness) {
      const directoryPreferences = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            '/api/files/directory-preferences' &&
          response.request().method() === 'GET' &&
          response.status() === 200,
        { timeout: 8_000 },
      );
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await directoryPreferences;
      await page
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      const defaultDirectory = page
        .locator('[role="treeitem"]')
        .filter({ hasText: DEFAULT_DIRECTORY_NAME });
      await defaultDirectory.waitFor({ state: 'visible', timeout: 15_000 });
      const initialNavigationResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/files/tree' &&
          response.status() === 200,
        { timeout: 8_000 },
      );
      await defaultDirectory.dblclick();
      await initialNavigationResponse;
      const [response] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            new URL(candidate.url()).pathname === '/api/files/tree' &&
            candidate.status() === 200,
          { timeout: 8_000 },
        ),
        page
          .getByRole('button', {
            name: `경로로 이동: ${path.basename(harness.workspace.root)}`,
            exact: true,
          })
          .click(),
      ]);
      assert(
        response.ok(),
        '브레드크럼 이동이 데몬 tree fetch를 트리거하지 않음',
      );
      await defaultDirectory.waitFor({ state: 'visible', timeout: 8_000 });
      const secondNavigationResponse = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === '/api/files/tree' &&
          candidate.status() === 200,
        { timeout: 8_000 },
      );
      await defaultDirectory.dblclick();
      await secondNavigationResponse;

      const contextBar = page.locator('.composer-context-bar');
      await contextBar.click();
      const dialog = page.getByRole('dialog', { name: '시작 위치 선택' });
      await dialog.waitFor({ state: 'visible', timeout: 8_000 });
      const computerScope = await page.evaluate(async () => {
        const response = await fetch('/api/files/computer-scope');
        return {
          status: response.status,
          body: await response.json(),
        };
      });
      assert(
        computerScope.status === 200 &&
          computerScope.body?.available === true &&
          Array.isArray(computerScope.body.browseShortcuts),
        'computer-scope owner did not return an available shortcut projection',
      );
      const projectedShortcuts = computerScope.body.browseShortcuts.filter(
        (shortcut) => shortcut.path !== computerScope.body.browseStartPath,
      );
      const quickAccess = page.getByRole('navigation', {
        name: '빠른 위치',
      });
      for (const shortcut of projectedShortcuts) {
        await quickAccess
          .getByRole('button', { name: shortcut.label, exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: 8_000 });
        const pickerShortcut = dialog
          .getByTitle(shortcut.path === '' ? '컴퓨터' : shortcut.path, {
            exact: true,
          })
          .filter({ hasText: shortcut.label })
          .first();
        await pickerShortcut.waitFor({ state: 'visible', timeout: 8_000 });
      }
      const windowsHostProjection = {
        checked: false,
        reason: 'windows_host_projection_not_expected',
        drivePath: null,
        knownFolderPath: null,
      };
      const windowsHostProjectionExpected =
        process.platform === 'win32' ||
        (process.platform === 'linux' &&
          os.release().toLowerCase().includes('microsoft'));
      if (windowsHostProjectionExpected) {
        const driveShortcut = projectedShortcuts.find((shortcut) =>
          /^Windows \([A-Z]:\)$/u.test(shortcut.label),
        );
        const normalizedDrivePath = driveShortcut?.path
          .replaceAll('\\', '/')
          .replace(/\/+$/u, '')
          .toLowerCase();
        const knownFolderShortcut = projectedShortcuts.find(
          (shortcut) =>
            !/^Windows \([A-Z]:\)$/u.test(shortcut.label) &&
            normalizedDrivePath !== undefined &&
            shortcut.path
              .replaceAll('\\', '/')
              .toLowerCase()
              .startsWith(`${normalizedDrivePath}/`),
        );
        assert(
          driveShortcut !== undefined && knownFolderShortcut !== undefined,
          'Windows host computer-scope did not expose both a drive and a known folder',
        );
        await dialog
          .getByRole('button', { name: '시작 위치 선택 닫기' })
          .click();
        for (const shortcut of [driveShortcut, knownFolderShortcut]) {
          const shortcutResponse = page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return (
                url.pathname === '/api/files/tree' &&
                url.searchParams.get('path') === shortcut.path
              );
            },
            { timeout: 15_000 },
          );
          await quickAccess
            .getByRole('button', { name: shortcut.label, exact: true })
            .first()
            .click();
          assert(
            (await shortcutResponse).status() === 200,
            `Windows host shortcut did not open: ${shortcut.path}`,
          );
        }
        const homeResponse = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              url.pathname === '/api/files/tree' &&
              url.searchParams.get('path') ===
                computerScope.body.browseStartPath
            );
          },
          { timeout: 15_000 },
        );
        await quickAccess
          .getByRole('button', { name: '홈', exact: true })
          .click();
        assert(
          (await homeResponse).status() === 200,
          'Windows host home shortcut did not restore the browse root',
        );
        windowsHostProjection.checked = true;
        windowsHostProjection.reason = null;
        windowsHostProjection.drivePath = driveShortcut.path;
        windowsHostProjection.knownFolderPath = knownFolderShortcut.path;
        await contextBar.click();
        await dialog.waitFor({ state: 'visible', timeout: 8_000 });
      }
      const defaultPath = await measureDirectoryLocation(page, dialog, {
        label: 'default',
        path: harness.workspace.root,
        firstDirectoryName: DEFAULT_DIRECTORY_NAME,
        directoryNames: [DEFAULT_DIRECTORY_NAME, RECENT_DIRECTORY_NAME],
      });
      const recentPath = await measureDirectoryLocation(page, dialog, {
        label: 'recent',
        path: path.relative(
          path.parse(harness.workspace.recentDirectory).root,
          harness.workspace.recentDirectory,
        ),
        firstDirectoryName: RECENT_DIRECTORY_CHILD_NAMES[0],
        directoryNames: RECENT_DIRECTORY_CHILD_NAMES,
      });
      await dialog.getByRole('button', { name: '시작 위치 선택 닫기' }).click();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .locator('.assistant-title-dot.connected')
        .waitFor({ state: 'visible', timeout: 15_000 });
      const image = await measureBinaryPreview(page, {
        kind: 'image',
        fileName: IMAGE_FILE_NAME,
        path: harness.workspace.imageFile,
        appUrl,
      });
      const video = await measureBinaryPreview(page, {
        kind: 'video',
        fileName: VIDEO_FILE_NAME,
        path: harness.workspace.videoFile,
        appUrl,
      });
      return {
        userVisible: {
          directories: {
            default: defaultPath,
            recent: recentPath,
            computerScopeProjection: {
              platform: process.platform,
              shortcutCount: projectedShortcuts.length,
              labels: projectedShortcuts.map((shortcut) => shortcut.label),
              windowsHost: windowsHostProjection,
            },
          },
          media: { image, video },
        },
      };
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
      await page
        .locator('.assistant-title-dot.connected')
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
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
      error: String(error?.stack ?? error?.message ?? error)
        .split('\n')
        .slice(0, 4)
        .join(' | ')
        .slice(0, 500),
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
        'artifact-frame-is-opaque-and-cannot-inherit-shell-authority',
        (page) => runArtifactOpaqueOriginIsolationFlow(page, harness),
      ),
    );
    const artifactResult = await executeBrowserFlow(
      browser,
      'artifact-commits-opens-controls-and-reloads-durably',
      (page) => runArtifactFlow(page, harness),
    );
    results.push(artifactResult);
    results.push(
      await executeBrowserFlow(
        browser,
        'subagent-observes-stops-and-reloads-durably',
        (page) => runSubagentFlow(page, harness),
      ),
    );
    const daemonRestartRecoveryResult = await executeBrowserFlow(
      browser,
      'daemon-restart-restores-active-approval-child-artifact-and-media',
      (page) => runApprovalFlow(page, harness),
    );
    results.push(daemonRestartRecoveryResult);
    results.push(
      await executeBrowserFlow(
        browser,
        'plan-stays-visible-while-steer-is-queued',
        (page) => runPlanSteerFlow(page, harness),
      ),
    );
    const genericResults = new Map();
    for (const flow of flows) {
      const result = await executeBrowserFlow(browser, flow.name, (page) =>
        flow.run(page, harness.appUrl, harness),
      );
      genericResults.set(flow.name, result);
      results.push(result);
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
    if (
      restartEvidenceOutputPath !== undefined &&
      daemonRestartRecoveryResult.ok &&
      daemonRestartRecoveryResult.evidence !== undefined
    ) {
      await writePrivatePerformanceReport(
        path.resolve(repoRoot, restartEvidenceOutputPath),
        {
          schemaVersion: 1,
          environment: collectBrowserPerformanceEnvironment({
            repoRoot,
            browserVersion,
          }),
          ...daemonRestartRecoveryResult.evidence,
        },
      );
    }
    const appResult = genericResults.get('app-loads-and-daemon-connected');
    const fileBrowserResult = genericResults.get(
      'file-browser-navigates-via-daemon',
    );
    if (
      userVisiblePerformanceOutputPath !== undefined &&
      results.every((result) => result.ok) &&
      reconnectRecoveryResult.evidence !== undefined &&
      runSettlementResult.evidence !== undefined &&
      artifactResult.evidence !== undefined &&
      appResult?.evidence !== undefined &&
      fileBrowserResult?.evidence !== undefined
    ) {
      await writePrivatePerformanceReport(
        path.resolve(repoRoot, userVisiblePerformanceOutputPath),
        buildFlowGateUserVisiblePerformanceSample({
          environment: collectBrowserPerformanceEnvironment({
            repoRoot,
            browserVersion,
          }),
          results,
          reconnectRecovery: reconnectRecoveryResult.evidence,
          runSettlement: runSettlementResult.evidence,
          artifact: artifactResult.evidence,
          app: appResult.evidence,
          fileBrowser: fileBrowserResult.evidence,
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
