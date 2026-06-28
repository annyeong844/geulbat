import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { bootstrapDaemonEntry } from './bootstrap-entry.js';

const execFileAsync = promisify(execFile);

void test('bootstrapDaemonEntry loads env before importing main', async () => {
  const calls: string[] = [];

  await bootstrapDaemonEntry({
    loadEnv: () => {
      calls.push('loadEnv');
    },
    importMain: async () => {
      calls.push('importMain');
    },
  });

  assert.deepEqual(calls, ['loadEnv', 'importMain']);
});

void test('bootstrapDaemonEntry does not import main when env loading fails', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      bootstrapDaemonEntry({
        loadEnv: () => {
          calls.push('loadEnv');
          throw new Error('env failed');
        },
        importMain: async () => {
          calls.push('importMain');
        },
      }),
    /env failed/,
  );

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry validates provider runtime knobs before importing main', async () => {
  const calls: string[] = [];
  const previous = process.env['GEULBAT_CODEX_REASONING_EFFORT'];

  try {
    await assert.rejects(
      () =>
        bootstrapDaemonEntry({
          loadEnv: () => {
            calls.push('loadEnv');
            process.env['GEULBAT_CODEX_REASONING_EFFORT'] = 'mid';
          },
          importMain: async () => {
            calls.push('importMain');
          },
        }),
      /invalid GEULBAT_CODEX_REASONING_EFFORT: mid/,
    );
  } finally {
    restoreEnv('GEULBAT_CODEX_REASONING_EFFORT', previous);
  }

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry validates subagent runtime knobs before importing main', async () => {
  const calls: string[] = [];
  const previous = process.env['GEULBAT_SUBAGENT_BACKGROUND_CAPACITY'];

  try {
    await assert.rejects(
      () =>
        bootstrapDaemonEntry({
          loadEnv: () => {
            calls.push('loadEnv');
            process.env['GEULBAT_SUBAGENT_BACKGROUND_CAPACITY'] = 'foo';
          },
          importMain: async () => {
            calls.push('importMain');
          },
        }),
      /invalid GEULBAT_SUBAGENT_BACKGROUND_CAPACITY: foo/,
    );
  } finally {
    restoreEnv('GEULBAT_SUBAGENT_BACKGROUND_CAPACITY', previous);
  }

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry validates PTC cell runtime knobs before importing main', async () => {
  const calls: string[] = [];
  const previous = process.env['GEULBAT_PTC_CELL_ENABLED'];

  try {
    await assert.rejects(
      () =>
        bootstrapDaemonEntry({
          loadEnv: () => {
            calls.push('loadEnv');
            process.env['GEULBAT_PTC_CELL_ENABLED'] = 'sometimes';
          },
          importMain: async () => {
            calls.push('importMain');
          },
        }),
      /invalid GEULBAT_PTC_CELL_ENABLED: sometimes/,
    );
  } finally {
    restoreEnv('GEULBAT_PTC_CELL_ENABLED', previous);
  }

  assert.deepEqual(calls, ['loadEnv']);
});

void test('bootstrapDaemonEntry loads env before import-time websocket provider headers', async () => {
  const expectedHeader = 'responses_websockets=test-local-env';
  const bootstrapEntryUrl = new URL('./bootstrap-entry.js', import.meta.url);
  const websocketConnectionUrl = new URL(
    './daemon/llm/provider/transport/responses-websocket-connection.js',
    import.meta.url,
  );

  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      buildWebSocketHeaderBootstrapProbe({
        bootstrapEntryUrl: bootstrapEntryUrl.href,
        websocketConnectionUrl: websocketConnectionUrl.href,
        expectedHeader,
      }),
    ],
    { env: process.env },
  );
});

void test('bootstrapDaemonEntry still loads env before surfacing main import failure', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      bootstrapDaemonEntry({
        loadEnv: () => {
          calls.push('loadEnv');
        },
        importMain: async () => {
          calls.push('importMain');
          throw new Error('main failed');
        },
      }),
    /main failed/,
  );

  assert.deepEqual(calls, ['loadEnv', 'importMain']);
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function buildWebSocketHeaderBootstrapProbe(args: {
  bootstrapEntryUrl: string;
  websocketConnectionUrl: string;
  expectedHeader: string;
}): string {
  return `
import { createServer } from 'node:http';
import { once } from 'node:events';

delete process.env.GEULBAT_WS_BETA_HEADER;

const expectedHeader = ${JSON.stringify(args.expectedHeader)};
const { bootstrapDaemonEntry } = await import(${JSON.stringify(args.bootstrapEntryUrl)});
let observedHeader;

await bootstrapDaemonEntry({
  loadEnv: () => {
    process.env.GEULBAT_WS_BETA_HEADER = expectedHeader;
  },
  importMain: async () => {
    const server = createServer();
    server.on('upgrade', (request, socket) => {
      observedHeader = request.headers['openai-beta'];
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    try {
      const { connectWebSocket } = await import(${JSON.stringify(args.websocketConnectionUrl)});
      await connectWebSocket(\`ws://127.0.0.1:\${address.port}\`, new Headers());
    } catch {
      // The local probe server destroys the upgrade socket after reading headers.
    } finally {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  },
});

if (observedHeader !== expectedHeader) {
  throw new Error(\`expected OpenAI-Beta \${expectedHeader}, got \${observedHeader}\`);
}
`;
}
