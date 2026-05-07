import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import {
  PUBLIC_WEB_DOM_COUNTER_PATH,
  PUBLIC_WEB_EVENTSOURCE_ECHO_PATH,
  PUBLIC_WEB_JSON_ECHO_PATH,
  PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
  PUBLIC_WEB_WEBSOCKET_ECHO_PATH,
} from '@geulbat/protocol/public-web-fixtures';

import { buildHtmlArtifactRuntimePayload } from '../src/features/assistant/artifacts/html/document.ts';
import { buildJsArtifactRuntimeDocument } from '../src/features/assistant/artifacts/js/document.ts';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  createArtifactRuntimeHostBootMessage,
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
const daemonHost = '127.0.0.1';
const SUPPORTED_CONFORMANCE_FIXTURE_NAMES = [
  'inline-script-dom-mutation',
  'external-script-dom-mutation',
  'data-url-image-script',
  'fetch-json-echo',
  'xhr-json-echo',
  'websocket-echo',
  'eventsource-echo-stream',
  'implicit-host-identity-forwarding',
  'artifact-storage-persistence',
];
const DATA_URL_HEART_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='%23ff5e8f' d='M10 18C9.5 17.5 3 13.2 3 7.8C3 5 5 3 7.6 3C9 3 10 3.7 10 5C10 3.7 11 3 12.4 3C15 3 17 5 17 7.8C17 13.2 10.5 17.5 10 18Z'/%3E%3C/svg%3E";
const DATA_URL_STATUS_SCRIPT =
  "data:text/javascript,document.getElementById('status').textContent='ready';";

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const daemonPort = await reserveFreePort();
  const daemonOrigin = `http://${daemonHost}:${daemonPort}`;
  const daemonHostUrl = new URL('/artifact-runtime/host', `${daemonOrigin}/`);
  const conformanceFixtures = resolveConformanceFixtures(
    process.env['GEULBAT_PUBLIC_WEB_CONFORMANCE_FIXTURE'],
    daemonOrigin,
  );
  console.log(
    `public-web conformance smoke: fixtures=${conformanceFixtures
      .map((fixture) => fixture.name)
      .join(',')}`,
  );

  const daemonLogs = [];
  const daemon = startDaemon({
    repoRoot,
    logs: daemonLogs,
    port: daemonPort,
  });

  try {
    await waitForDaemonReady(daemonHostUrl, daemonLogs);
    for (const fixture of conformanceFixtures) {
      console.log(`public-web conformance smoke: fixture=${fixture.name}`);
      const harness = await createConformanceHarnessServer(
        fixture,
        daemonOrigin,
      );
      try {
        await runSmoke(harness.url, fixture);
      } finally {
        await closeServer(harness.server);
      }
    }
  } finally {
    await stopProcess(daemon);
  }
}

function resolveConformanceFixtures(value, daemonOrigin) {
  const requestedNames =
    typeof value === 'string' && value.trim() !== ''
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : ['all'];
  const fixtureNames = requestedNames.includes('all')
    ? SUPPORTED_CONFORMANCE_FIXTURE_NAMES
    : requestedNames;
  return fixtureNames.map((fixtureName) =>
    resolveConformanceFixture(fixtureName, daemonOrigin),
  );
}

function resolveConformanceFixture(name, daemonOrigin) {
  if (name === 'inline-script-dom-mutation') {
    return createDomMutationFixture({
      name,
      title: 'inline script DOM mutation conformance',
      scriptTag: [
        '<script>',
        'let count = 0;',
        "document.getElementById('btn')?.addEventListener('click', () => {",
        '  count += 1;',
        "  const value = document.getElementById('value');",
        '  if (value) {',
        '    value.textContent = String(count);',
        '  }',
        '});',
        '</script>',
      ].join('\n'),
    });
  }

  if (name === 'external-script-dom-mutation') {
    return createDomMutationFixture({
      name,
      title: 'external script DOM mutation conformance',
      scriptTag: `<script src="${new URL(
        PUBLIC_WEB_DOM_COUNTER_PATH,
        `${daemonOrigin}/`,
      ).toString()}"></script>`,
    });
  }

  if (name === 'data-url-image-script') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        return buildHtmlArtifactRuntimePayload(
          [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8" />',
            '<title>data URL image and script conformance</title>',
            '</head>',
            '<body>',
            '<img',
            '  id="heart"',
            '  alt="heart"',
            `  src="${DATA_URL_HEART_IMAGE}"`,
            '>',
            '<div id="status">loading</div>',
            `<script src="${DATA_URL_STATUS_SCRIPT}"></script>`,
            '</body>',
            '</html>',
          ].join('\n'),
        );
      },
      assertConforms: assertDataUrlImageScriptConforms,
    };
  }

  if (name === 'fetch-json-echo') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        const echoUrl = new URL(PUBLIC_WEB_JSON_ECHO_PATH, `${daemonOrigin}/`);
        echoUrl.searchParams.set('message', 'hello');
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'loading';",
          'document.body.appendChild(pre);',
          `fetch(${JSON.stringify(echoUrl.toString())})`,
          '  .then((response) => response.json())',
          '  .then((json) => {',
          "    pre.textContent = String(json.message ?? '');",
          "    pre.dataset.method = String(json.method ?? '');",
          "    pre.dataset.path = String(json.path ?? '');",
          '  });',
        ].join('\n');
      },
      assertConforms: assertFetchJsonEchoConforms,
    };
  }

  if (name === 'xhr-json-echo') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        const echoUrl = new URL(PUBLIC_WEB_JSON_ECHO_PATH, `${daemonOrigin}/`);
        echoUrl.searchParams.set('message', 'xhr');
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'loading';",
          'document.body.appendChild(pre);',
          'const xhr = new XMLHttpRequest();',
          `xhr.open('GET', ${JSON.stringify(echoUrl.toString())});`,
          'xhr.onload = () => {',
          '  const json = JSON.parse(xhr.responseText);',
          "  pre.textContent = String(json.message ?? '');",
          "  pre.dataset.method = String(json.method ?? '');",
          "  pre.dataset.path = String(json.path ?? '');",
          '};',
          'xhr.onerror = () => {',
          "  pre.textContent = 'xhr-error';",
          '};',
          'xhr.send();',
        ].join('\n');
      },
      assertConforms: assertXhrJsonEchoConforms,
    };
  }

  if (name === 'websocket-echo') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        const echoUrl = new URL(
          PUBLIC_WEB_WEBSOCKET_ECHO_PATH,
          `${daemonOrigin}/`,
        );
        echoUrl.protocol = echoUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'connecting';",
          'document.body.appendChild(pre);',
          `const socket = new WebSocket(${JSON.stringify(echoUrl.toString())});`,
          "socket.addEventListener('open', () => socket.send('hello'));",
          "socket.addEventListener('message', (event) => {",
          '  pre.textContent = String(event.data);',
          '  socket.close();',
          '});',
          "socket.addEventListener('error', () => {",
          "  pre.textContent = 'websocket-error';",
          '});',
        ].join('\n');
      },
      assertConforms: assertWebSocketEchoConforms,
    };
  }

  if (name === 'eventsource-echo-stream') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        const streamUrl = new URL(
          PUBLIC_WEB_EVENTSOURCE_ECHO_PATH,
          `${daemonOrigin}/`,
        );
        streamUrl.searchParams.set('message', 'stream');
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'connecting';",
          'document.body.appendChild(pre);',
          `const stream = new EventSource(${JSON.stringify(streamUrl.toString())});`,
          "stream.addEventListener('message', (event) => {",
          '  pre.textContent = String(event.data);',
          '  stream.close();',
          '});',
          "stream.addEventListener('error', () => {",
          "  if (pre.textContent !== 'stream') {",
          "    pre.textContent = 'eventsource-error';",
          '  }',
          '});',
        ].join('\n');
      },
      assertConforms: assertEventSourceEchoConforms,
    };
  }

  if (name === 'implicit-host-identity-forwarding') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      async prepareContext(context) {
        await context.addCookies([
          {
            name: 'geulbat_identity_probe',
            value: 'host-cookie',
            url: `${daemonOrigin}/`,
          },
        ]);
      },
      buildRuntimePayload() {
        const echoUrl = new URL(
          PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
          `${daemonOrigin}/`,
        );
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'loading';",
          'document.body.appendChild(pre);',
          `fetch(${JSON.stringify(echoUrl.toString())})`,
          '  .then((response) => response.json())',
          '  .then((json) => {',
          "    pre.dataset.cookie = String(json.cookie ?? '');",
          "    pre.dataset.authorization = String(json.authorization ?? '');",
          "    pre.dataset.devToken = String(json.devToken ?? '');",
          "    pre.dataset.referrer = String(json.referrer ?? '');",
          '    const leaked = Boolean(',
          '      json.cookie ||',
          '        json.authorization ||',
          '        json.devToken ||',
          '        json.referrer,',
          '    );',
          "    pre.textContent = leaked ? 'identity-leaked' : 'identity-clean';",
          '  })',
          '  .catch(() => {',
          "    pre.textContent = 'identity-error';",
          '  });',
        ].join('\n');
      },
      assertConforms: assertImplicitHostIdentityForwardingConforms,
    };
  }

  if (name === 'artifact-storage-persistence') {
    return {
      name,
      screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
      buildRuntimePayload() {
        return [
          "const pre = document.createElement('pre');",
          "pre.id = 'result';",
          "pre.textContent = 'loading';",
          'document.body.appendChild(pre);',
          '(async () => {',
          "  const key = 'counter';",
          "  const current = Number(localStorage.getItem(key) ?? '0') + 1;",
          '  localStorage.setItem(key, String(current));',
          '  const committed = await window.storage.get(key);',
          '  pre.dataset.counter = String(current);',
          "  pre.dataset.committed = String(committed ?? '');",
          '  pre.textContent = `counter:${current}`;',
          '})().catch((error) => {',
          '  pre.dataset.error = error instanceof Error ? error.message : String(error);',
          "  pre.textContent = 'storage-error';",
          '});',
        ].join('\n');
      },
      assertConforms: assertArtifactStoragePersistenceConforms,
    };
  }

  throw new Error(
    `unsupported public-web conformance fixture "${name}". Expected one of: all, ${SUPPORTED_CONFORMANCE_FIXTURE_NAMES.join(', ')}.`,
  );
}

async function reserveFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, daemonHost, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('public-web smoke could not reserve a daemon port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createDomMutationFixture(args) {
  const { name, title, scriptTag } = args;
  return {
    name,
    screenshotPath: path.join(outputDir, `public-web-${name}-smoke.png`),
    buildRuntimePayload() {
      return buildHtmlArtifactRuntimePayload(
        [
          '<!doctype html>',
          '<html lang="en">',
          '<head>',
          '<meta charset="utf-8" />',
          `<title>${title}</title>`,
          '</head>',
          '<body>',
          '<button id="btn" type="button">increment</button>',
          '<span id="value">0</span>',
          scriptTag,
          '</body>',
          '</html>',
        ].join('\n'),
      );
    },
    assertConforms: assertDomCounterConforms,
  };
}

async function assertDomCounterConforms(page) {
  const frame = page.frameLocator('#artifact-frame');
  const button = frame.locator('#btn');
  const value = frame.locator('#value');

  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await value.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await value.textContent(), '0');

  await button.click();
  await frame.locator('#value').filter({ hasText: '1' }).waitFor({
    state: 'visible',
    timeout: 5_000,
  });
  assert.equal(await value.textContent(), '1');
}

async function assertDataUrlImageScriptConforms(page) {
  const frame = page.frameLocator('#artifact-frame');
  const image = frame.locator('#heart');
  const status = frame.locator('#status');

  await image.waitFor({ state: 'visible', timeout: 15_000 });
  await status.filter({ hasText: 'ready' }).waitFor({
    state: 'visible',
    timeout: 5_000,
  });

  const naturalWidth = await image.evaluate((element) =>
    element instanceof HTMLImageElement ? element.naturalWidth : 0,
  );
  assert.ok(naturalWidth > 0, 'data URL image must decode with naturalWidth');
  assert.equal(await status.textContent(), 'ready');
}

async function assertFetchJsonEchoConforms(page) {
  await assertJsonEchoConforms(page, 'hello');
}

async function assertXhrJsonEchoConforms(page) {
  await assertJsonEchoConforms(page, 'xhr');
}

async function assertWebSocketEchoConforms(page) {
  const frame = page.frameLocator('#artifact-frame');
  const result = frame.locator('#result');

  await result.filter({ hasText: 'hello' }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  assert.equal(await result.textContent(), 'hello');
}

async function assertEventSourceEchoConforms(page) {
  const frame = page.frameLocator('#artifact-frame');
  const result = frame.locator('#result');

  await result.filter({ hasText: 'stream' }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  assert.equal(await result.textContent(), 'stream');
}

async function assertImplicitHostIdentityForwardingConforms(page) {
  const frame = page.frameLocator('#artifact-frame');
  const result = frame.locator('#result');

  await result.filter({ hasText: 'identity-clean' }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  const debug = await result.evaluate((element) => ({
    text: element.textContent,
    cookie: element instanceof HTMLElement ? element.dataset.cookie : '',
    authorization:
      element instanceof HTMLElement ? element.dataset.authorization : '',
    devToken: element instanceof HTMLElement ? element.dataset.devToken : '',
    referrer: element instanceof HTMLElement ? element.dataset.referrer : '',
  }));

  assert.deepEqual(debug, {
    text: 'identity-clean',
    cookie: '',
    authorization: '',
    devToken: '',
    referrer: '',
  });
}

async function assertArtifactStoragePersistenceConforms(page) {
  await assertStorageCounterState(page, 'counter:1', '1', '1');

  await page.locator('#artifact-frame').evaluate((element) => {
    if (!(element instanceof HTMLIFrameElement)) {
      return;
    }
    const nextUrl = new URL(element.src);
    nextUrl.searchParams.set('reload', String(Date.now()));
    element.src = nextUrl.toString();
  });

  await assertStorageCounterState(page, 'counter:2', '2', '2');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await assertStorageCounterState(page, 'counter:1', '1', '1');
}

async function assertStorageCounterState(
  page,
  expectedText,
  expectedCounter,
  expectedCommitted,
) {
  const frame = page.frameLocator('#artifact-frame');
  const result = frame.locator('#result');

  await result.filter({ hasText: expectedText }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  const debug = await result.evaluate((element) => ({
    text: element.textContent,
    counter: element instanceof HTMLElement ? element.dataset.counter : '',
    committed: element instanceof HTMLElement ? element.dataset.committed : '',
    error: element instanceof HTMLElement ? (element.dataset.error ?? '') : '',
  }));

  assert.deepEqual(debug, {
    text: expectedText,
    counter: expectedCounter,
    committed: expectedCommitted,
    error: '',
  });
}

async function assertJsonEchoConforms(page, expectedText) {
  const frame = page.frameLocator('#artifact-frame');
  const result = frame.locator('#result');

  await result.filter({ hasText: expectedText }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  const debug = await result.evaluate((element) => ({
    text: element.textContent,
    method: element instanceof HTMLElement ? element.dataset.method : '',
    path: element instanceof HTMLElement ? element.dataset.path : '',
  }));

  assert.deepEqual(debug, {
    text: expectedText,
    method: 'GET',
    path: PUBLIC_WEB_JSON_ECHO_PATH,
  });
}

async function createConformanceHarnessServer(fixture, daemonOrigin) {
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
    runtimeFrameUrl.searchParams.set('rev', `public-web-${fixture.name}`);

    const scopeHandle = `scope-${randomUUID()}`;
    const runtimeDocument = buildJsArtifactRuntimeDocument(
      fixture.buildRuntimePayload(),
      {
        scopeHandle,
        parentOrigin: harnessOrigin,
      },
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      buildConformanceHarnessHtml({
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
    throw new Error(
      'public-web conformance harness did not bind to a TCP port',
    );
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

function buildConformanceHarnessHtml(args) {
  const { runtimeDocument, runtimeFrameUrl, scopeHandle, runtimeHostOrigin } =
    args;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>geulbat public-web conformance smoke</title>
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
    <h1>public-web conformance smoke</h1>
    <iframe
      id="artifact-frame"
      title="public-web conformance smoke"
      sandbox="allow-scripts allow-forms allow-same-origin"
      src=${JSON.stringify(runtimeFrameUrl)}
    ></iframe>
    <script>
      (() => {
        const runtimeHostOrigin = ${JSON.stringify(runtimeHostOrigin)};
        const scopeHandle = ${JSON.stringify(scopeHandle)};
        const bootMessage = ${escapeInlineScriptJson(
          createArtifactRuntimeHostBootMessage(runtimeDocument),
        )};
        const iframe = document.getElementById('artifact-frame');
        const shared = {
          revision: null,
          state: null,
          revisionIndex: 0,
        };

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

async function runSmoke(harnessUrl, fixture) {
  let browser;
  const launchEnv = await resolveChromiumLaunchEnv({
    repoRoot,
    tolerateMissingExecutable: true,
  });
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
    const context = await browser.newContext();
    try {
      await fixture.prepareContext?.(context);
      const page = await context.newPage();
      const browserLogs = [];
      page.on('console', (message) => {
        browserLogs.push(`[console:${message.type()}] ${message.text()}`);
      });
      page.on('pageerror', (error) => {
        browserLogs.push(`[pageerror] ${error.message}`);
      });
      await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
      try {
        await fixture.assertConforms(page);
        await page.screenshot({ path: fixture.screenshotPath, fullPage: true });
      } catch (error) {
        await page.screenshot({
          path: fixture.screenshotPath.replace(/\.png$/, '-failure.png'),
          fullPage: true,
        });
        const detail =
          browserLogs.length > 0 ? `\n${browserLogs.join('\n')}` : '';
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}${detail}`,
        );
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
  }
}

await main();
