import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer as createViteServer, transformWithEsbuild } from 'vite';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
  ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
} from '@geulbat/protocol/artifact-runtime-host';

import {
  closeServer,
  resolveChromiumLaunchEnv,
} from './smoke-harness-utils.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const appRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const VIRTUAL_ENTRY_ID = 'virtual:geulbat-assistant-transcript-smoke.tsx';
const RESOLVED_VIRTUAL_ENTRY_ID = `\0${VIRTUAL_ENTRY_ID}`;

async function main() {
  const harness = await createTranscriptHarnessServer();
  try {
    await runTranscriptSmoke(harness.url);
  } finally {
    await closeServer(harness.server);
    await harness.vite.close();
  }
}

async function createTranscriptHarnessServer() {
  const vite = await createViteServer({
    root: appRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    plugins: [
      {
        name: 'geulbat-assistant-transcript-smoke',
        resolveId(id) {
          return id === VIRTUAL_ENTRY_ID ? RESOLVED_VIRTUAL_ENTRY_ID : null;
        },
        async load(id) {
          if (id !== RESOLVED_VIRTUAL_ENTRY_ID) {
            return null;
          }
          return transformWithEsbuild(
            buildTranscriptHarnessEntry(),
            'assistant-transcript-virtualization-smoke-entry.tsx',
            { loader: 'tsx', jsx: 'automatic' },
          );
        },
      },
    ],
  });
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(buildTranscriptHarnessHtml());
      return;
    }
    vite.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('assistant transcript smoke server did not bind');
  }
  return {
    server,
    vite,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

function buildTranscriptHarnessHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>geulbat assistant transcript virtualization smoke</title>
    <style>
      html, body, #root { height: 100%; }
      body { margin: 0; }
      #smoke-shell { box-sizing: border-box; height: 100%; padding: 16px; }
      #outside-focus { margin-bottom: 8px; }
      [role="log"] { height: 480px !important; overflow-y: auto !important; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${VIRTUAL_ENTRY_ID}"></script>
  </body>
</html>`;
}

function buildTranscriptHarnessEntry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/app/App.css';
import { AssistantTranscript } from '/src/features/assistant/AssistantTranscript.tsx';

const messages = Array.from({ length: 90 }, (_, index) => ({
  entryId: 'message-' + index,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: 'ordinary transcript message ' + index,
  timestamp: new Date(index).toISOString(),
}));
messages[2] = {
  entryId: 'focus-row',
  role: 'assistant',
  content: '[FOCUS_ROW_SENTINEL](#focus-row)',
  timestamp: new Date(2).toISOString(),
};
messages[84] = {
  entryId: 'tall-row',
  role: 'assistant',
  content: ['TALL_ROW_SENTINEL']
    .concat(Array.from({ length: 48 }, (_, index) => 'tall paragraph ' + index))
    .join('\\n\\n'),
  timestamp: new Date(84).toISOString(),
};
messages[85] = {
  entryId: 'after-tall-row',
  role: 'user',
  content: 'AFTER_TALL_ROW_SENTINEL',
  timestamp: new Date(85).toISOString(),
};
messages[87] = {
  entryId: 'visualize-row',
  role: 'tool_call',
  content: JSON.stringify({
    tool: 'visualize',
    args: {
      code: '<main style="height:640px">VISUALIZE_FRAME_SENTINEL</main>',
      title: 'Stable visualization',
    },
  }),
  timestamp: new Date(87).toISOString(),
};
messages[88] = {
  entryId: 'after-visualize-row',
  role: 'assistant',
  content: 'AFTER_VISUALIZE_SENTINEL',
  timestamp: new Date(88).toISOString(),
};

function Harness() {
  return (
    <main id="smoke-shell">
      <button id="outside-focus" type="button">outside transcript</button>
      <AssistantTranscript
        messages={messages}
        artifacts={[]}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        activeArtifact={null}
        streamError={null}
        isRunning={false}
        onStartArtifactRun={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`;
}

function buildRuntimeHostDocument() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>html, body { margin: 0; overflow: hidden; } #content { height: 640px; }</style>
  </head>
  <body>
    <div id="content">VISUALIZE_FRAME_SENTINEL</div>
    <script>
      (() => {
        const parentOrigin = new URL(location.href).searchParams.get('parentOrigin');
        if (!parentOrigin) return;
        const post = (message) => parent.postMessage(message, parentOrigin);
        setTimeout(() => post({
          kind: ${JSON.stringify(ARTIFACT_RUNTIME_HOST_MESSAGE_KIND)},
          action: ${JSON.stringify(ARTIFACT_RUNTIME_HOST_READY_ACTION)},
        }), 0);
        let resized = false;
        addEventListener('message', (event) => {
          if (event.source !== parent || event.origin !== parentOrigin || resized) return;
          resized = true;
          post({
            kind: ${JSON.stringify(ARTIFACT_RUNTIME_HOST_MESSAGE_KIND)},
            action: ${JSON.stringify(ARTIFACT_RUNTIME_HOST_RESIZE_ACTION)},
            height: 640,
          });
        });
      })();
    </script>
  </body>
</html>`;
}

async function runTranscriptSmoke(harnessUrl) {
  const launchEnv = await resolveChromiumLaunchEnv({
    repoRoot,
    tolerateMissingExecutable: true,
  });
  let browser;
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
    await page.route('**/artifact-runtime/host**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: buildRuntimeHostDocument(),
      }),
    );
    await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });

    try {
      const transcript = page.getByRole('log', {
        name: 'Assistant transcript',
      });
      await transcript.waitFor();

      await transcript.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      const focusLink = page.getByRole('link', { name: 'FOCUS_ROW_SENTINEL' });
      await focusLink.waitFor();
      await focusLink.focus();
      await transcript.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
      await waitForAnimationFrames(page, 3);
      assert.equal(await focusLink.count(), 1);
      assert.equal(
        await focusLink.evaluate(
          (element) => document.activeElement === element,
        ),
        true,
      );

      await page.locator('#outside-focus').click();
      await waitForAnimationFrames(page, 3);
      assert.equal(await focusLink.count(), 0);

      const tallRow = page
        .getByText('TALL_ROW_SENTINEL', { exact: true })
        .locator(
          'xpath=ancestor::div[contains(@class, "transcript-virtual-row")]',
        );
      const afterTallRow = page
        .getByText('AFTER_TALL_ROW_SENTINEL', { exact: true })
        .locator(
          'xpath=ancestor::div[contains(@class, "transcript-virtual-row")]',
        );
      await tallRow.waitFor();
      await afterTallRow.waitFor();
      await assertRowsDoNotOverlap(tallRow, afterTallRow);

      const iframe = page.getByTitle('Stable visualization');
      await iframe.waitFor();
      await page.waitForFunction(() => {
        const frame = document.querySelector(
          'iframe[title="Stable visualization"]',
        );
        return frame instanceof HTMLIFrameElement && frame.offsetHeight >= 640;
      });
      const afterVisualizeRow = page
        .getByText('AFTER_VISUALIZE_SENTINEL', { exact: true })
        .locator(
          'xpath=ancestor::div[contains(@class, "transcript-virtual-row")]',
        );
      await afterVisualizeRow.waitFor();
      const visualizeRow = iframe.locator(
        'xpath=ancestor::div[contains(@class, "transcript-virtual-row")]',
      );
      await assertRowsDoNotOverlap(visualizeRow, afterVisualizeRow);

      await iframe.evaluate((element) => {
        element.dataset.smokeIdentity = 'original';
        globalThis.__GEULBAT_TRANSCRIPT_IFRAME_LOADS__ = 0;
        element.addEventListener('load', () => {
          globalThis.__GEULBAT_TRANSCRIPT_IFRAME_LOADS__ += 1;
        });
      });
      await transcript.hover();
      await page.mouse.wheel(0, -180);
      await page.mouse.wheel(0, 180);
      await waitForAnimationFrames(page, 3);
      assert.equal(
        await iframe.getAttribute('data-smoke-identity'),
        'original',
      );
      assert.equal(
        await page.evaluate(
          () => globalThis.__GEULBAT_TRANSCRIPT_IFRAME_LOADS__,
        ),
        0,
      );

      const runtimeFrame = page
        .frames()
        .find((frame) => frame.url().includes('/artifact-runtime/host'));
      assert.ok(runtimeFrame);
      const runtimeOverflow = await runtimeFrame.evaluate(() => ({
        viewportHeight: innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      }));
      assert.ok(
        runtimeOverflow.documentHeight <= runtimeOverflow.viewportHeight + 1,
        `visualize runtime overflowed: ${JSON.stringify(runtimeOverflow)}`,
      );
    } catch (error) {
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

async function assertRowsDoNotOverlap(firstRow, nextRow) {
  const firstBox = await firstRow.boundingBox();
  const nextBox = await nextRow.boundingBox();
  assert.ok(
    firstBox && nextBox,
    'virtual transcript rows must have layout boxes',
  );
  assert.ok(
    firstBox.y + firstBox.height <= nextBox.y + 1,
    `virtual transcript rows overlap: ${JSON.stringify({ firstBox, nextBox })}`,
  );
}

async function waitForAnimationFrames(page, count) {
  await page.evaluate(
    (frameCount) =>
      new Promise((resolve) => {
        let remaining = frameCount;
        const step = () => {
          remaining -= 1;
          if (remaining <= 0) {
            resolve(undefined);
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    count,
  );
}

await main();
