import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import test from 'node:test';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from './lab-browser-runtime-script.js';
import { runPtcBrowserRuntimeScript } from '../../../../../test-support/ptc-browser-runtime-script.js';

interface PolicyEventServer {
  origin: string;
  close(): Promise<void>;
  requests: string[];
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
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
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

void test('browser runtime script rejects popups that fire after domcontentloaded', async () => {
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

void test('browser runtime script rejects downloads that fire after domcontentloaded', async () => {
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
