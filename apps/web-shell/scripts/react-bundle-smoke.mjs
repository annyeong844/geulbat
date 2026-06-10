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
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
} from '@geulbat/protocol/public-web-fixtures';

import { buildJsArtifactRuntimeDocument } from '../src/features/artifacts/runtime-preview/js/document.ts';
import { buildReactBundleArtifactRuntimePayload } from '../src/features/artifacts/runtime-preview/react-bundle/document.ts';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
  createArtifactRuntimeHostBootMessage,
  DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
} from '../src/features/assistant/runtime-frame/artifact-runtime-host.ts';
import { buildJsRuntimePersistenceBootstrap } from '../src/features/assistant/runtime-persistence/artifact-runtime-persistence-bootstrap.ts';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
} from '../src/features/assistant/runtime-persistence/artifact-runtime-persistence-types.ts';
import { validateReactBundleArtifactPayload } from '../src/features/artifacts/react-bundle/validator.ts';
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

async function main() {
  const smokeFixture = await resolveSmokeFixture({
    name: process.env['GEULBAT_REACT_BUNDLE_SMOKE_FIXTURE'],
    manifestFilePath: process.env['GEULBAT_REACT_BUNDLE_SMOKE_MANIFEST_FILE'],
  });
  const smokeManifest = smokeFixture.manifest(daemonOrigin);

  await fs.mkdir(outputDir, { recursive: true });
  console.log(
    `react bundle smoke: fixture=${smokeFixture.name} entry=${smokeManifest.entryUrl}`,
  );

  const daemonLogs = [];
  const daemon = startDaemon({ repoRoot, logs: daemonLogs, watch: true });

  try {
    await waitForDaemonReady(daemonHostUrl, daemonLogs);
    const harness = await createSmokeHarnessServer(smokeFixture);
    try {
      await runSmoke(harness.url, smokeFixture, daemonOrigin);
    } finally {
      await closeServer(harness.server);
    }
  } finally {
    await stopProcess(daemon);
  }
}

async function createSmokeHarnessServer(smokeFixture) {
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
    const manifest = smokeFixture.manifest(daemonOrigin);
    const runtimePayload = buildReactBundleArtifactRuntimePayload(manifest);
    const persistenceBootstrap = {
      scopeHandle,
      parentOrigin: harnessOrigin,
    };
    const runtimeDocument = buildJsArtifactRuntimeDocument(runtimePayload, {
      ...persistenceBootstrap,
      bootstrapSource: buildJsRuntimePersistenceBootstrap(persistenceBootstrap),
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

async function runSmoke(harnessUrl, smokeFixture, daemonOrigin) {
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
    if (typeof smokeFixture.routeDependencies === 'function') {
      await smokeFixture.routeDependencies(page, daemonOrigin);
    }
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

async function resolveSmokeFixture(options = {}) {
  const fixtureName = options.name ?? 'hello-card';
  if (options.manifestFilePath) {
    if (!options.name) {
      throw new Error(
        'manifest_fixture_required: GEULBAT_REACT_BUNDLE_SMOKE_FIXTURE must be set when GEULBAT_REACT_BUNDLE_SMOKE_MANIFEST_FILE is used',
      );
    }
    const assertionFixture = await resolveSmokeFixture({ name: fixtureName });
    const manifest = await readSmokeManifestFile(options.manifestFilePath);
    assertionFixture.validateManifest?.(manifest);
    return {
      ...assertionFixture,
      name: `manifest-file:${fixtureName}`,
      manifest() {
        return manifest;
      },
    };
  }

  if (fixtureName === 'counter') {
    return {
      name: 'counter',
      manifest(origin) {
        return {
          entryUrl: new URL(
            PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
            `${origin}/`,
          ).toString(),
        };
      },
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
      manifest(origin) {
        return {
          entryUrl: new URL(
            PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
            `${origin}/`,
          ).toString(),
        };
      },
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

  if (fixtureName === 'runtime-dependencies') {
    return {
      name: 'runtime-dependencies',
      manifest(origin) {
        return {
          entryUrl: new URL(
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
            `${origin}/`,
          ).toString(),
          runtimeDependencies: {
            importMap: {
              imports: {
                'geulbat-runtime-dependency-fixture': new URL(
                  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
                  `${origin}/`,
                ).toString(),
              },
            },
            stylesheets: [
              new URL(
                PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
                `${origin}/`,
              ).toString(),
            ],
          },
        };
      },
      persistenceState: {
        'publicWebFixture.reactRuntimeDependencies': {
          booted: true,
        },
      },
      async assertMounted(page) {
        await assertRuntimeDependencyFixtureMounted(page);
      },
    };
  }

  if (fixtureName === 'accepted-runtime-dependencies') {
    return {
      name: 'accepted-runtime-dependencies',
      manifest(origin) {
        return {
          entryUrl: new URL(
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
            `${origin}/`,
          ).toString(),
          runtimeDependencies: {
            importMap: {
              imports: {
                [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
                  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
              },
            },
            stylesheets: [
              PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
            ],
          },
        };
      },
      validateManifest(manifest) {
        assertAcceptedRuntimeDependenciesManifest(manifest);
      },
      async routeDependencies(page) {
        await page.route('https://esm.sh/**', async (route) => {
          if (
            route.request().url() ===
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL
          ) {
            await fulfillFromDaemonFixture(
              route,
              PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
              'text/javascript; charset=utf-8',
            );
            return;
          }
          failUnexpectedDependencyRoute(route);
        });
        await page.route('https://cdn.jsdelivr.net/**', async (route) => {
          if (
            route.request().url() ===
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL
          ) {
            await fulfillFromDaemonFixture(
              route,
              PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
              'text/css; charset=utf-8',
            );
            return;
          }
          failUnexpectedDependencyRoute(route);
        });
      },
      persistenceState: {
        'publicWebFixture.reactRuntimeDependencies': {
          booted: true,
        },
      },
      async assertMounted(page) {
        await assertRuntimeDependencyFixtureMounted(page);
      },
    };
  }

  throw new Error(
    `unsupported react bundle smoke fixture "${fixtureName}". Expected "hello-card", "counter", "runtime-dependencies", or "accepted-runtime-dependencies".`,
  );
}

async function readSmokeManifestFile(filePath) {
  let rawManifest;
  try {
    rawManifest = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `manifest_file_missing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    JSON.parse(rawManifest);
  } catch (error) {
    throw new Error(
      `manifest_file_invalid_json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const validation = validateReactBundleArtifactPayload(rawManifest);
  if (!validation.ok) {
    throw new Error(`manifest_shape_invalid: ${validation.detail}`);
  }

  return validation.manifest;
}

async function fulfillFromDaemonFixture(route, fixturePath, contentType) {
  const response = await fetch(new URL(fixturePath, `${daemonOrigin}/`));
  if (!response.ok) {
    throw new Error(
      `runtime_dependency_route_unmatched: daemon fixture ${fixturePath} returned ${response.status}`,
    );
  }

  await route.fulfill({
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
    },
    body: await response.text(),
  });
}

function assertAcceptedRuntimeDependenciesManifest(manifest) {
  const imports = manifest.runtimeDependencies?.importMap?.imports ?? {};
  const stylesheets = manifest.runtimeDependencies?.stylesheets ?? [];
  const expectedEntryUrl = new URL(
    PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
    `${daemonOrigin}/`,
  ).toString();
  const importEntries = Object.entries(imports);
  if (
    manifest.entryUrl !== expectedEntryUrl ||
    importEntries.length !== 1 ||
    imports[PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER] !==
      PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL ||
    stylesheets.length !== 1 ||
    !stylesheets.includes(
      PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
    )
  ) {
    throw new Error(
      'manifest_fixture_mismatch: accepted-runtime-dependencies fixture requires the expected runtime dependency URLs',
    );
  }
}

function failUnexpectedDependencyRoute(route) {
  throw new Error(
    `runtime_dependency_route_unmatched: unexpected runtime dependency request ${route.request().url()}`,
  );
}

async function assertRuntimeDependencyFixtureMounted(page) {
  const frame = page.frameLocator('#artifact-frame');
  const card = frame.locator('#runtime-dependency-card');
  const label = frame.locator('#runtime-dependency-label');

  await card.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await label.textContent(), 'runtime dependency loaded');
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).borderTopColor),
    'rgb(70, 120, 50)',
  );
}

await main();
