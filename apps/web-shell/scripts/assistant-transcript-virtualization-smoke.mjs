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
import { writePrivatePerformanceReport } from '../../../scripts/performance-report-support.mjs';
import { buildAssistantTranscriptPerformanceReport } from './assistant-transcript-performance-report.mjs';
import { collectBrowserPerformanceEnvironment } from './performance-report-support.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const appRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const VIRTUAL_ENTRY_ID = 'virtual:geulbat-assistant-transcript-smoke.tsx';
const RESOLVED_VIRTUAL_ENTRY_ID = `\0${VIRTUAL_ENTRY_ID}`;
const RUN_PERFORMANCE_PROBE = process.argv.includes('--performance');
const PERFORMANCE_RUN_COUNT = readPositiveIntegerOption(
  '--performance-runs',
  1,
);
const PERFORMANCE_OUTPUT_PATH = readStringOption('--performance-output');
const PERFORMANCE_MESSAGE_COUNT = 2_000;
const PERFORMANCE_LIVE_UPDATE_COUNT = 20;
const PERFORMANCE_BATCH_SETTLE_MS = 80;

async function main() {
  const harness = await createTranscriptHarnessServer();
  try {
    await runTranscriptSmoke(harness.url, {
      runPerformanceProbe: RUN_PERFORMANCE_PROBE,
      performanceRunCount: PERFORMANCE_RUN_COUNT,
      performanceOutputPath: PERFORMANCE_OUTPUT_PATH,
    });
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
    server: { middlewareMode: true, hmr: false, watch: null },
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
import { createRunSessionStreamBatchController } from '/src/app/run-session-stream-batch.ts';
import { AssistantTranscript } from '/src/features/assistant/AssistantTranscript.tsx';

globalThis.__GEULBAT_INITIAL_TRANSCRIPT_ROW_READS__ = [];
globalThis.__GEULBAT_INITIAL_TRANSCRIPT_VIEWPORT_RECT_READS__ = 0;
globalThis.__GEULBAT_INITIAL_TRANSCRIPT_SCROLL_TO_CALLS__ = [];
globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__ = [];
globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__ = null;
const EMPTY_ITEMS = [];
const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight',
);
if (offsetHeightDescriptor?.get) {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    ...offsetHeightDescriptor,
    get() {
      if (this.classList.contains('transcript-virtual-row')) {
        globalThis.__GEULBAT_INITIAL_TRANSCRIPT_ROW_READS__.push(
          Number(this.dataset.index),
        );
      }
      return offsetHeightDescriptor.get.call(this);
    },
  });
}
const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.getAttribute('role') === 'log') {
    globalThis.__GEULBAT_INITIAL_TRANSCRIPT_VIEWPORT_RECT_READS__ += 1;
  }
  return getBoundingClientRect.call(this);
};
const scrollTo = HTMLElement.prototype.scrollTo;
HTMLElement.prototype.scrollTo = function (...args) {
  if (this.getAttribute('role') === 'log') {
    globalThis.__GEULBAT_INITIAL_TRANSCRIPT_SCROLL_TO_CALLS__.push(args);
  }
  return scrollTo.apply(this, args);
};

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
messages[80] = {
  entryId: 'earlier-tall-row',
  role: 'assistant',
  content: ['EARLIER_TALL_ROW_SENTINEL']
    .concat(
      Array.from(
        { length: 48 },
        (_, index) => 'earlier tall paragraph ' + index,
      ),
    )
    .join('\\n\\n'),
  timestamp: new Date(80).toISOString(),
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

function createPerformanceMessages(count) {
  return Array.from({ length: count }, (_, index) => {
    const common = {
      entryId: 'performance-message-' + index,
      timestamp: new Date(index).toISOString(),
    };
    if (index % 10 === 0) {
      return {
        ...common,
        role: 'tool_call',
        content: JSON.stringify({
          callId: 'performance-call-' + index,
          tool: 'read_file',
          args: { path: '/tmp/performance-' + index + '.txt' },
        }),
      };
    }
    if (index % 10 === 1) {
      return {
        ...common,
        role: 'tool_result',
        content: JSON.stringify({
          callId: 'performance-call-' + (index - 1),
          tool: 'read_file',
          ok: true,
        }),
      };
    }
    return {
      ...common,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'performance transcript message ' + index,
    };
  });
}

function recordTranscriptProfilerCommit(
  _id,
  phase,
  actualDuration,
  baseDuration,
) {
  globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__.push({
    phase,
    actualDuration,
    baseDuration,
  });
}

function Harness() {
  const [threadMessages, setThreadMessages] = React.useState([]);
  const [transcriptEntries, setTranscriptEntries] = React.useState([]);
  const [finalAnswerText, setFinalAnswerText] = React.useState('');
  const [isPerformanceRunning, setIsPerformanceRunning] =
    React.useState(false);
  const performanceSnapshotRef = React.useRef({
    activityCount: 0,
    finalAnswerText: '',
    isRunning: false,
    settledAnswerCount: 0,
  });
  performanceSnapshotRef.current = {
    activityCount: transcriptEntries.length,
    finalAnswerText,
    isRunning: isPerformanceRunning,
    settledAnswerCount: threadMessages.filter(
      (message) => message.entryId === 'performance-settled-answer',
    ).length,
  };
  const performanceEntryIndexRef = React.useRef(0);
  const performanceDispatchRef = React.useRef(() => {});
  performanceDispatchRef.current = (action) => {
    if (action.type === 'assistant_text_streamed') {
      setFinalAnswerText((current) => current + action.text);
      return;
    }
    if (action.type !== 'transcript_activity_added') {
      return;
    }
    setTranscriptEntries((current) => [...current, action.entry]);
  };
  const [performanceBatchController] = React.useState(() =>
    createRunSessionStreamBatchController({
      readDispatch: () => performanceDispatchRef.current,
    }),
  );
  const handleStartArtifactRun = React.useCallback(() => {}, []);
  const rowInteractions = React.useMemo(
    () => ({ onStartArtifactRun: handleStartArtifactRun }),
    [handleStartArtifactRun],
  );
  React.useEffect(() => {
    setThreadMessages(messages);
  }, []);
  React.useEffect(() => {
    const appendLiveActivity = () => {
      const index = performanceEntryIndexRef.current;
      performanceEntryIndexRef.current += 1;
      performanceBatchController.queueDisplayEffect({
        kind: 'transcript_activity_added',
        runId: 'performance-run',
        threadId: 'performance-thread',
        entry: {
          kind: 'tool_activity',
          tool: 'read_file',
          state: index % 2 === 0 ? 'running' : 'completed',
          callId: 'performance-call-' + index,
        },
        computerFilesMayHaveChanged: false,
      });
    };
    const appendLiveText = () => {
      const index = performanceEntryIndexRef.current;
      performanceEntryIndexRef.current += 1;
      performanceBatchController.queueStreamedTextEffect({
        kind: 'assistant_text_streamed',
        threadId: 'performance-thread',
        target: 'answer',
        text: 'performance-text-' + index + '|',
      });
    };
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__ = {
      prepare(messageCount) {
        performanceBatchController.clearPendingStreamEffects();
        performanceEntryIndexRef.current = 0;
        setThreadMessages(createPerformanceMessages(messageCount));
        setTranscriptEntries([]);
        setFinalAnswerText('');
        setIsPerformanceRunning(true);
      },
      appendLiveActivity() {
        appendLiveActivity();
      },
      async appendLiveActivityBurst(count) {
        for (let index = 0; index < count; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          appendLiveActivity();
        }
      },
      async appendLiveTextBurst(count) {
        for (let index = 0; index < count; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          appendLiveText();
        }
      },
      resetLiveActivity() {
        performanceBatchController.clearPendingStreamEffects();
        performanceEntryIndexRef.current = 0;
        setTranscriptEntries([]);
      },
      resetLiveText() {
        performanceBatchController.clearPendingStreamEffects();
        performanceEntryIndexRef.current = 0;
        setFinalAnswerText('');
      },
      readSnapshot() {
        return performanceSnapshotRef.current;
      },
      settle() {
        performanceBatchController.flushPendingStreamEffects();
        setThreadMessages((current) => [
          ...current.map((message) => ({ ...message })),
          {
            entryId: 'performance-settled-answer',
            role: 'assistant',
            content: 'performance settled answer',
            timestamp: new Date().toISOString(),
          },
        ]);
        setTranscriptEntries([]);
        setFinalAnswerText('');
        setIsPerformanceRunning(false);
      },
    };
    return () => {
      performanceBatchController.clearPendingStreamEffects();
      globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__ = null;
    };
  }, [performanceBatchController]);

  return (
    <main id="smoke-shell">
      <button id="outside-focus" type="button">outside transcript</button>
      <React.Profiler
        id="assistant-transcript"
        onRender={recordTranscriptProfilerCommit}
      >
        <AssistantTranscript
          threadId="performance-thread"
          messages={threadMessages}
          artifacts={EMPTY_ITEMS}
          transcriptEntries={transcriptEntries}
          finalAnswerText={finalAnswerText}
          activeArtifact={null}
          streamError={null}
          isRunning={isPerformanceRunning}
          rowInteractions={rowInteractions}
        />
      </React.Profiler>
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

async function runTranscriptSmoke(
  harnessUrl,
  { runPerformanceProbe, performanceRunCount, performanceOutputPath },
) {
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
      await page.waitForFunction(() => {
        const element = document.querySelector('[role="log"]');
        return (
          element instanceof HTMLElement &&
          element.scrollHeight - element.scrollTop - element.clientHeight <= 1
        );
      });

      const initialMeasuredRowIndexes = await page.evaluate(
        () => globalThis.__GEULBAT_INITIAL_TRANSCRIPT_ROW_READS__,
      );
      assert.deepEqual(
        initialMeasuredRowIndexes,
        [],
        `initial transcript render synchronously read row geometry: ${JSON.stringify(initialMeasuredRowIndexes)}`,
      );
      assert.equal(
        await page.evaluate(
          () => globalThis.__GEULBAT_INITIAL_TRANSCRIPT_VIEWPORT_RECT_READS__,
        ),
        0,
        'initial transcript render synchronously read viewport geometry',
      );
      assert.deepEqual(
        await page.evaluate(
          () => globalThis.__GEULBAT_INITIAL_TRANSCRIPT_SCROLL_TO_CALLS__,
        ),
        [],
        'the virtualizer duplicated the pinned transcript scroll owner',
      );

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
      await waitForAnimationFrames(page, 3);
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
      await waitForAnimationFrames(page, 3);
      await assertRowsDoNotOverlap(visualizeRow, afterVisualizeRow);

      await iframe.evaluate((element) => {
        element.dataset.smokeIdentity = 'original';
        globalThis.__GEULBAT_TRANSCRIPT_IFRAME_LOADS__ = 0;
        element.addEventListener('load', () => {
          globalThis.__GEULBAT_TRANSCRIPT_IFRAME_LOADS__ += 1;
        });
      });
      const scrollDeltas = [-1200, -1200, -1200, -1200, 1200, 1200, 1200, 1200];
      for (const [step, deltaY] of scrollDeltas.entries()) {
        await transcript.evaluate((element, scrollDelta) => {
          element.scrollTop += scrollDelta;
          element.dispatchEvent(new Event('scroll'));
        }, deltaY);
        await page.waitForTimeout(120);
        if (step === 3) {
          await page.waitForTimeout(250);
        }
        assert.equal(
          await iframe.count(),
          1,
          'visualize iframe must remain mounted throughout one scroll gesture',
        );
      }
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
      if (runPerformanceProbe) {
        const samples = [];
        for (let index = 0; index < performanceRunCount; index += 1) {
          const startedAt = performance.now();
          const result = await runTranscriptPerformanceProbe(page);
          samples.push({
            index,
            cacheState: index === 0 ? 'cold' : 'warm',
            wallDurationMs: Number((performance.now() - startedAt).toFixed(3)),
            result,
          });
        }
        const performanceResult = buildAssistantTranscriptPerformanceReport({
          environment: collectBrowserPerformanceEnvironment({
            repoRoot,
            browserVersion: browser.version(),
          }),
          fixture: {
            messageCount: PERFORMANCE_MESSAGE_COUNT,
            liveUpdateCount: PERFORMANCE_LIVE_UPDATE_COUNT,
            cacheDefinition: {
              cold: 'first performance sample in one fresh browser process after the correctness smoke',
              warm: 'later samples in the same browser and Vite process',
            },
          },
          samples,
        });
        const resolvedOutputPath =
          performanceOutputPath === undefined
            ? undefined
            : path.resolve(repoRoot, performanceOutputPath);
        if (resolvedOutputPath !== undefined) {
          await writePrivatePerformanceReport(
            resolvedOutputPath,
            performanceResult,
          );
        }
        console.log(
          `[assistant-transcript-performance] ${JSON.stringify({
            outputPath: resolvedOutputPath ?? null,
            aggregates: performanceResult.aggregates,
          })}`,
        );
      }
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

async function runTranscriptPerformanceProbe(page) {
  await page.evaluate((messageCount) => {
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.prepare(messageCount);
  }, PERFORMANCE_MESSAGE_COUNT);
  await page.waitForFunction(
    () => globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__.length > 0,
  );
  await waitForAnimationFrames(page, 3);
  await resetTranscriptProfilerCommits(page);
  await startTranscriptResponsivenessObservation(page);

  for (let index = 0; index < PERFORMANCE_LIVE_UPDATE_COUNT; index += 1) {
    const previousCommitCount = await readTranscriptProfilerCommitCount(page);
    await page.evaluate(() => {
      globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.appendLiveActivity();
    });
    await page.waitForFunction(
      (commitCount) =>
        globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__.length > commitCount,
      previousCommitCount,
    );
    await waitForAnimationFrames(page, 1);
  }
  const liveUpdateCommits = await readTranscriptProfilerCommits(page);

  await page.evaluate(() => {
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.resetLiveActivity();
  });
  await waitForAnimationFrames(page, 2);
  await page
    .getByRole('log', { name: 'Assistant transcript' })
    .evaluate((element) => {
      element.scrollTop = Math.floor(
        (element.scrollHeight - element.clientHeight) / 2,
      );
      element.dispatchEvent(new Event('scroll'));
    });
  await waitForAnimationFrames(page, 2);
  const activityBurstScrollBefore = await readTranscriptScrollTop(page);
  await resetTranscriptProfilerCommits(page);
  await page.evaluate(
    (updateCount) =>
      globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.appendLiveActivityBurst(
        updateCount,
      ),
    PERFORMANCE_LIVE_UPDATE_COUNT,
  );
  await page.waitForTimeout(PERFORMANCE_BATCH_SETTLE_MS);
  await waitForAnimationFrames(page, 2);
  const activityBurstCommits = await readTranscriptProfilerCommits(page);
  const activityBurstScrollAfter = await readTranscriptScrollTop(page);
  const activityBurstScrollJumpPx = Number(
    (activityBurstScrollAfter - activityBurstScrollBefore).toFixed(3),
  );
  assert.ok(
    Math.abs(activityBurstScrollJumpPx) <= 1,
    `live activity moved an unpinned transcript viewport: ${activityBurstScrollJumpPx}px`,
  );

  await page.evaluate(() => {
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.resetLiveText();
  });
  await waitForAnimationFrames(page, 2);
  await resetTranscriptProfilerCommits(page);
  await page.evaluate(
    (updateCount) =>
      globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.appendLiveTextBurst(
        updateCount,
      ),
    PERFORMANCE_LIVE_UPDATE_COUNT,
  );
  await page.waitForTimeout(PERFORMANCE_BATCH_SETTLE_MS);
  await waitForAnimationFrames(page, 2);
  const textBurstCommits = await readTranscriptProfilerCommits(page);
  const liveTextSnapshot = await readTranscriptPerformanceSnapshot(page);
  const expectedLiveText = Array.from(
    { length: PERFORMANCE_LIVE_UPDATE_COUNT },
    (_, index) => `performance-text-${index}|`,
  ).join('');
  assert.equal(liveTextSnapshot.finalAnswerText, expectedLiveText);

  await resetTranscriptProfilerCommits(page);
  await page.evaluate(() => {
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.settle();
  });
  await page.waitForFunction(
    () => globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__.length > 0,
  );
  await waitForAnimationFrames(page, 3);
  const settleCommits = await readTranscriptProfilerCommits(page);
  const settledSnapshot = await readTranscriptPerformanceSnapshot(page);
  assert.deepEqual(settledSnapshot, {
    activityCount: 0,
    finalAnswerText: '',
    isRunning: false,
    settledAnswerCount: 1,
  });
  const responsiveness = await stopTranscriptResponsivenessObservation(page);

  return {
    fixture: {
      messageCount: PERFORMANCE_MESSAGE_COUNT,
      liveUpdateCount: PERFORMANCE_LIVE_UPDATE_COUNT,
    },
    liveUpdates: summarizeProfilerCommits(liveUpdateCommits),
    activityBurst: summarizeProfilerCommits(activityBurstCommits),
    textBurst: summarizeProfilerCommits(textBurstCommits),
    settle: summarizeProfilerCommits(settleCommits),
    responsiveness,
    correctness: {
      activityBurstScrollJumpPx,
      duplicateSettledRows: settledSnapshot.settledAnswerCount - 1,
      pendingActivityCount: settledSnapshot.activityCount,
      pendingAnswerBytes: settledSnapshot.finalAnswerText.length,
      finalRunningState: settledSnapshot.isRunning,
    },
  };
}

async function resetTranscriptProfilerCommits(page) {
  await page.evaluate(() => {
    globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__ = [];
  });
}

async function readTranscriptProfilerCommitCount(page) {
  return await page.evaluate(
    () => globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__.length,
  );
}

async function readTranscriptProfilerCommits(page) {
  return await page.evaluate(
    () => globalThis.__GEULBAT_TRANSCRIPT_PROFILER_COMMITS__,
  );
}

async function readTranscriptPerformanceSnapshot(page) {
  return await page.evaluate(() =>
    globalThis.__GEULBAT_TRANSCRIPT_PERFORMANCE_CONTROL__.readSnapshot(),
  );
}

async function readTranscriptScrollTop(page) {
  return await page
    .getByRole('log', { name: 'Assistant transcript' })
    .evaluate((element) => element.scrollTop);
}

async function startTranscriptResponsivenessObservation(page) {
  await page.evaluate(() => {
    const state = {
      frameGaps: [],
      lastFrameAt: performance.now(),
      longTasks: [],
      observer: null,
      requestId: 0,
    };
    const tick = (now) => {
      state.frameGaps.push(now - state.lastFrameAt);
      state.lastFrameAt = now;
      state.requestId = requestAnimationFrame(tick);
    };
    state.requestId = requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push(entry.duration);
        }
      });
      state.observer.observe({ type: 'longtask' });
    }
    globalThis.__GEULBAT_TRANSCRIPT_RESPONSIVENESS__ = state;
  });
}

async function stopTranscriptResponsivenessObservation(page) {
  return await page.evaluate(() => {
    const state = globalThis.__GEULBAT_TRANSCRIPT_RESPONSIVENESS__;
    cancelAnimationFrame(state.requestId);
    state.observer?.disconnect();
    const frameBudgetMs = 1000 / 60;
    const droppedFrameEstimate = state.frameGaps.reduce(
      (total, gap) => total + Math.max(0, Math.floor(gap / frameBudgetMs) - 1),
      0,
    );
    const round = (value) => Number(value.toFixed(3));
    return {
      frameSampleCount: state.frameGaps.length,
      droppedFrameEstimate,
      maxFrameGapMs: round(Math.max(0, ...state.frameGaps)),
      longTaskSupported:
        PerformanceObserver.supportedEntryTypes.includes('longtask'),
      longTaskCount: state.longTasks.length,
      longTaskTotalDurationMs: round(
        state.longTasks.reduce((total, duration) => total + duration, 0),
      ),
      longTaskMaxDurationMs: round(Math.max(0, ...state.longTasks)),
    };
  });
}

function summarizeProfilerCommits(commits) {
  const durations = commits.map((commit) => commit.actualDuration);
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const totalActualDurationMs = durations.reduce(
    (total, duration) => total + duration,
    0,
  );
  return {
    commitCount: commits.length,
    totalActualDurationMs: Number(totalActualDurationMs.toFixed(3)),
    medianActualDurationMs: Number(
      (sortedDurations[Math.floor(sortedDurations.length / 2)] ?? 0).toFixed(3),
    ),
    maxActualDurationMs: Number(Math.max(0, ...durations).toFixed(3)),
  };
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

function readStringOption(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === name) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  if (values.length > 1) {
    throw new Error(`${name} may be provided only once`);
  }
  const value = values[0];
  if (value !== undefined && value.length === 0) {
    throw new Error(`${name} requires a non-empty value`);
  }
  return value;
}

function readPositiveIntegerOption(name, fallback) {
  const value = readStringOption(name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

await main();
