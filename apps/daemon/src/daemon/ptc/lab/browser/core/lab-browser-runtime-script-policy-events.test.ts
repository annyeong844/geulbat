import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
} from './lab-browser-runtime-script.js';
import {
  hasWorkspacePlaywrightChromium,
  runPtcBrowserRuntimeScript,
} from '../../../../../test-support/ptc-browser-runtime-script.js';

interface PolicyEventServer {
  origin: string;
  close(): Promise<void>;
  requests: string[];
}

async function closePolicyEventServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeAllConnections();
  await closed;
}

async function withPolicyEventServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  fn: (server: PolicyEventServer) => Promise<T>,
): Promise<T> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP test server address');
  }

  try {
    return await fn({
      origin: `http://127.0.0.1:${address.port}`,
      requests,
      close: async () => {
        await closePolicyEventServer(server);
      },
    });
  } finally {
    if (server.listening) {
      await closePolicyEventServer(server);
    }
  }
}

function html(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Policy Probe</title>${body}`;
}

async function runPageLoadEvidenceRuntime(targetUrl: string) {
  return await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    input: {
      targetUrl,
      timeoutMs: 5_000,
      loadWaitState: 'domcontentloaded',
    },
    useWorkspacePlaywright: true,
    timeoutMs: 60_000,
  });
}

async function runTextEvidenceRuntime(targetUrl: string) {
  return await runPtcBrowserRuntimeScript({
    script: PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
    input: {
      targetUrl,
      timeoutMs: 5_000,
      loadWaitState: 'domcontentloaded',
    },
    useWorkspacePlaywright: true,
    timeoutMs: 60_000,
  });
}

void test('text evidence captures visible text after domcontentloaded without waiting for network idle', async (t) => {
  if (!(await hasWorkspacePlaywrightChromium())) {
    t.skip('workspace Playwright Chromium is not installed');
    return;
  }

  await withPolicyEventServer(
    (request, response) => {
      if (request.url === '/hanging-image') {
        response.writeHead(200, { 'content-type': 'image/png' });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        html(
          `<main>Ready visible text</main><img alt="" src="/hanging-image">`,
        ),
      );
    },
    async (server) => {
      const run = await runTextEvidenceRuntime(`${server.origin}/`);

      assert.equal(run.exitCode, 0);
      assert.equal(run.stderr, '');
      const output = run.jsonLines[0] as Record<string, unknown>;
      assert.deepEqual(run.jsonLines, [
        {
          capability: 'ptc_lab_browser_dom_text_evidence',
          checks: {
            engineAvailable: true,
            contextCreated: true,
            navigationStarted: true,
            navigationSettled: true,
            redirectPolicyEnforced: true,
            downloadPolicyEnforced: true,
            popupPolicyEnforced: true,
            evidenceCaptured: true,
            cleanupCompleted: true,
          },
          ok: true,
          loadOutcome: 'loaded',
          loadState: 'domcontentloaded',
          finalUrlDigest: output.finalUrlDigest,
          visibleText: 'Ready visible text',
          redirectCount: 0,
          navigationDurationMs: output.navigationDurationMs,
        },
      ]);
      assert.equal(server.requests.includes('/hanging-image'), true);
    },
  );
});

void test('browser runtime script rejects popups that fire after domcontentloaded', async (t) => {
  if (!(await hasWorkspacePlaywrightChromium())) {
    t.skip('workspace Playwright Chromium is not installed');
    return;
  }

  await withPolicyEventServer(
    (request, response) => {
      if (request.url === '/popup') {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        html(
          `<script>
          window.addEventListener('load', () => {
            window.open('/popup', '_blank');
          });
        </script>`,
        ),
      );
    },
    async (server) => {
      const run = await runPageLoadEvidenceRuntime(`${server.origin}/`);

      assert.equal(run.exitCode, 2);
      assert.equal(run.stderr, '');
      assert.deepEqual(run.jsonLines, [
        {
          capability: 'ptc_lab_browser_page_load_evidence',
          checks: {
            engineAvailable: true,
            contextCreated: true,
            navigationStarted: true,
            navigationSettled: true,
            redirectPolicyEnforced: true,
            downloadPolicyEnforced: true,
            popupPolicyEnforced: false,
            evidenceCaptured: true,
            cleanupCompleted: true,
          },
          ok: false,
          errorCode: 'popup_disallowed',
        },
      ]);
      assert.equal(server.requests.includes('/popup'), true);
    },
  );
});

void test('browser runtime script rejects downloads that fire after domcontentloaded', async (t) => {
  if (!(await hasWorkspacePlaywrightChromium())) {
    t.skip('workspace Playwright Chromium is not installed');
    return;
  }

  await withPolicyEventServer(
    (request, response) => {
      if (request.url === '/file.bin') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="file.bin"',
        });
        response.end('download');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        html(
          `<a id="download" href="/file.bin" download>download</a>
        <script>
          window.addEventListener('load', () => {
            document.getElementById('download').click();
          });
        </script>`,
        ),
      );
    },
    async (server) => {
      const run = await runPageLoadEvidenceRuntime(`${server.origin}/`);

      assert.equal(run.exitCode, 2);
      assert.equal(run.stderr, '');
      assert.deepEqual(run.jsonLines, [
        {
          capability: 'ptc_lab_browser_page_load_evidence',
          checks: {
            engineAvailable: true,
            contextCreated: true,
            navigationStarted: true,
            navigationSettled: true,
            redirectPolicyEnforced: true,
            downloadPolicyEnforced: false,
            popupPolicyEnforced: true,
            evidenceCaptured: true,
            cleanupCompleted: true,
          },
          ok: false,
          errorCode: 'download_disallowed',
        },
      ]);
      assert.equal(server.requests.includes('/file.bin'), true);
    },
  );
});
