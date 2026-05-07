import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import {
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
} from '@geulbat/protocol/public-web-fixtures';

import { buildJsArtifactRuntimeDocument } from '../src/features/assistant/artifacts/js/document.ts';
import { buildReactBundleArtifactRuntimePayload } from '../src/features/assistant/artifacts/react-bundle/document.ts';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  createArtifactRuntimeHostBootMessage,
  DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
} from '../src/features/assistant/runtime-frame/artifact-runtime-host.ts';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
} from '../src/features/assistant/runtime-persistence/artifact-runtime-persistence-types.ts';
import {
  closeServer,
  resolveChromiumLaunchEnv,
  startDaemon,
  stopProcess,
  waitForDaemonReady,
} from './smoke-harness-utils.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const appRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const outputDir = path.join(repoRoot, 'output', 'playwright');
const screenshotPath = path.join(outputDir, 'react-bundle-smoke-e2e.png');
const daemonOrigin = DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN;
const daemonHostUrl = new URL('/artifact-runtime/host', `${daemonOrigin}/`);
const smokeFixture = resolveSmokeFixture(
  process.env['GEULBAT_REACT_BUNDLE_SMOKE_FIXTURE'],
);
const reactBundleEntryUrl = new URL(
  smokeFixture.entryPath,
  `${daemonOrigin}/`,
).toString();

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  console.log(
    `react bundle smoke: fixture=${smokeFixture.name} entry=${reactBundleEntryUrl}`,
  );

  const daemonLogs = [];
  const daemon = startDaemon({ repoRoot, logs: daemonLogs, watch: true });

  try {
    await waitForDaemonReady(daemonHostUrl, daemonLogs);
    const harness = await createSmokeHarnessServer();
    try {
      await runSmoke(harness.url);
    } finally {
      await closeServer(harness.server);
    }
  } finally {
    await stopProcess(daemon);
  }
}

async function createSmokeHarnessServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const host = req.headers.host ?? '127.0.0.1';
    const harnessOrigin = `http://${host}`;
    const runtimeFrameUrl = new URL(
      '/artifact-runtime/host',
      `${daemonOrigin}/`,
    );
    runtimeFrameUrl.searchParams.set('parentOrigin', harnessOrigin);
    runtimeFrameUrl.searchParams.set('rev', 'react-bundle-smoke');
    const scopeHandle = `scope-${randomUUID()}`;
    const runtimePayload = buildReactBundleArtifactRuntimePayload({
      entryUrl: reactBundleEntryUrl,
    });
    const runtimeDocument = buildJsArtifactRuntimeDocument(runtimePayload, {
      scopeHandle,
      parentOrigin: harnessOrigin,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      buildSmokeHarnessHtml({
        runtimeDocument,
        runtimeFrameUrl: runtimeFrameUrl.toString(),
        scopeHandle,
        runtimeHostOrigin: daemonOrigin,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('smoke harness server did not bind to a TCP port');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

function buildSmokeHarnessHtml(args) {
  const { runtimeDocument, runtimeFrameUrl, scopeHandle, runtimeHostOrigin } =
    args;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>geulbat react bundle smoke</title>
    <style>
      body {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        margin: 24px;
      }
      iframe {
        width: 100%;
        min-height: 320px;
        border: 1px solid #d0d7de;
      }
    </style>
  </head>
  <body>
    <h1>react bundle smoke</h1>
    <iframe
      id="artifact-frame"
      title="react bundle smoke"
      sandbox="allow-scripts allow-forms allow-same-origin"
      src=${JSON.stringify(runtimeFrameUrl)}
    ></iframe>
    <script>
      (() => {
        const runtimeHostOrigin = ${JSON.stringify(runtimeHostOrigin)};
        const scopeHandle = ${JSON.stringify(scopeHandle)};
        const runtimeDocument = ${escapeInlineScriptJson(runtimeDocument)};
        const bootMessage = ${escapeInlineScriptJson(
          createArtifactRuntimeHostBootMessage(runtimeDocument),
        )};
        const iframe = document.getElementById('artifact-frame');
        const shared = {
          revision: null,
          state: null,
          revisionIndex: 0,
        };
        window.__GEULBAT_SMOKE_SHARED_PERSISTENCE__ = shared;

        const isRecord = (value) =>
          !!value && typeof value === 'object' && !Array.isArray(value);

        const createResponse = (request, extras) => ({
          kind: ${JSON.stringify(PERSISTENCE_RESPONSE_KIND)},
          version: ${JSON.stringify(PERSISTENCE_BRIDGE_VERSION)},
          requestId: request.requestId,
          scopeHandle,
          verb: request.verb,
          ...extras,
        });

        const handlePersistenceRequest = (request) => {
          if (
            !isRecord(request) ||
            request.kind !== ${JSON.stringify(PERSISTENCE_REQUEST_KIND)} ||
            request.version !== ${JSON.stringify(PERSISTENCE_BRIDGE_VERSION)} ||
            request.scopeHandle !== scopeHandle ||
            typeof request.requestId !== 'string'
          ) {
            return null;
          }

          if (request.verb === ${JSON.stringify(
            ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState,
          )}) {
            return createResponse(request, {
              ok: true,
              state: shared.state,
              revision: shared.revision,
            });
          }

          if (
            request.verb === ${JSON.stringify(
              ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState,
            )}
          ) {
            if (
              (request.expectedRevision ?? null) !== (shared.revision ?? null)
            ) {
              return createResponse(request, {
                ok: false,
                errorCode: 'persistence_conflict',
                message:
                  'runtime persistence revision does not match expectedRevision',
              });
            }
            shared.state = request.state ?? null;
            shared.revisionIndex += 1;
            shared.revision = 'rev-' + shared.revisionIndex;
            return createResponse(request, {
              ok: true,
              revision: shared.revision,
            });
          }

          if (
            request.verb === ${JSON.stringify(
              ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState,
            )}
          ) {
            if (
              (request.expectedRevision ?? null) !== (shared.revision ?? null)
            ) {
              return createResponse(request, {
                ok: false,
                errorCode: 'persistence_conflict',
                message:
                  'runtime persistence revision does not match expectedRevision',
              });
            }
            shared.state = null;
            shared.revision = null;
            return createResponse(request, {
              ok: true,
              revision: null,
            });
          }

          return null;
        };

        window.addEventListener('message', (event) => {
          if (
            event.source !== iframe.contentWindow ||
            event.origin !== runtimeHostOrigin
          ) {
            return;
          }

          const data = event.data;
          if (
            isRecord(data) &&
            data.kind === ${JSON.stringify(ARTIFACT_RUNTIME_HOST_MESSAGE_KIND)} &&
            data.action === ${JSON.stringify(ARTIFACT_RUNTIME_HOST_READY_ACTION)}
          ) {
            iframe.contentWindow?.postMessage(bootMessage, runtimeHostOrigin);
            return;
          }

          const response = handlePersistenceRequest(data);
          if (response) {
            iframe.contentWindow?.postMessage(response, runtimeHostOrigin);
          }
        });
      })();
    </script>
  </body>
</html>
`;
}

function escapeInlineScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

async function runSmoke(harnessUrl) {
  let browser;
  const launchEnv = await resolveChromiumLaunchEnv({ repoRoot });
  try {
    browser = await chromium.launch({ headless: true, env: launchEnv });
  } catch (error) {
    throw new Error(
      `Playwright Chromium is unavailable. Run \`npx playwright install chromium\` and retry. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const page = await browser.newPage();
    const browserLogs = [];
    page.on('console', (message) => {
      browserLogs.push(`[console:${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      browserLogs.push(`[pageerror] ${error.message}`);
    });
    await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
    try {
      await smokeFixture.assertMounted(page);

      const persistenceState = await page.evaluate(
        () => globalThis.__GEULBAT_SMOKE_SHARED_PERSISTENCE__,
      );

      assert.deepEqual(persistenceState?.state, smokeFixture.persistenceState);

      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (error) {
      await page.screenshot({
        path: screenshotPath.replace(/\.png$/, '-failure.png'),
        fullPage: true,
      });
      const detail =
        browserLogs.length > 0 ? `\n${browserLogs.join('\n')}` : '';
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }
  } finally {
    await browser?.close();
  }
}

function resolveSmokeFixture(name) {
  const fixtureName = name ?? 'hello-card';
  if (fixtureName === 'counter') {
    return {
      name: 'counter',
      entryPath: PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
      persistenceState: {
        'publicWebFixture.reactBundleCounter': {
          booted: true,
        },
      },
      async assertMounted(page) {
        const countButton = page
          .frameLocator('#artifact-frame')
          .locator('#count');
        await countButton.waitFor({ state: 'visible', timeout: 15_000 });
        assert.equal(await countButton.textContent(), 'count:0');

        await countButton.click();
        await page
          .frameLocator('#artifact-frame')
          .locator('text=count:1')
          .waitFor({
            state: 'visible',
            timeout: 5_000,
          });
      },
    };
  }

  if (fixtureName === 'hello-card') {
    return {
      name: 'hello-card',
      entryPath: PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
      persistenceState: {
        'publicWebFixture.reactHelloCard': {
          booted: true,
        },
      },
      async assertMounted(page) {
        const frame = page.frameLocator('#artifact-frame');
        const title = frame.locator('#title');
        const countButton = frame.locator('#count-button');
        const countOutput = frame.locator('#count-output');

        await title.waitFor({ state: 'visible', timeout: 15_000 });
        assert.equal(await title.textContent(), '안녕하세요 ;ㅅ;');
        assert.equal(await countButton.textContent(), '눌러보세요');
        assert.equal(await countOutput.textContent(), '클릭 수: 0');

        await countButton.click();
        await frame.locator('text=클릭 수: 1').waitFor({
          state: 'visible',
          timeout: 5_000,
        });
      },
    };
  }

  throw new Error(
    `unsupported react bundle smoke fixture "${fixtureName}". Expected "hello-card" or "counter".`,
  );
}

await main();
