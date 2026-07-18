import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const responsesWebSocketUrl = new URL(
    './daemon/llm/provider/transport/responses-websocket.js',
    import.meta.url,
  );

  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      buildWebSocketHeaderBootstrapProbe({
        bootstrapEntryUrl: bootstrapEntryUrl.href,
        responsesWebSocketUrl: responsesWebSocketUrl.href,
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

void test(
  'daemon main listens and releases its admission lock on SIGTERM',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'geulbat-main-lifecycle-'));
    const portReservation = createServer();
    await new Promise<void>((resolve, reject) => {
      portReservation.once('error', reject);
      portReservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (portReservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      portReservation.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./main.js', import.meta.url))],
      {
        env: {
          ...process.env,
          GEULBAT_COMPUTER_SESSION_DISABLED: '1',
          GEULBAT_DEV_TOKEN: 'daemon-main-test-token',
          GEULBAT_HOME_STATE_ROOT: join(root, 'home-state'),
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const ready = new Promise<void>((resolve, reject) => {
      const expected = `http://127.0.0.1:${port}`;
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes(expected)) {
          child.off('exit', onEarlyExit);
          resolve();
        }
      };
      const onEarlyExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        reject(
          new Error(
            `daemon main exited before listen: code=${String(code)} signal=${String(signal)} output=${output}`,
          ),
        );
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onEarlyExit);
    });

    try {
      await ready;
      const exited = once(child, 'exit');
      assert.equal(child.kill('SIGTERM'), true);
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null, output);
      await assert.rejects(
        rm(join(root, 'home-state', '.geulbat', 'daemon-admission-lock.json')),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'ENOENT',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function buildWebSocketHeaderBootstrapProbe(args: {
  bootstrapEntryUrl: string;
  responsesWebSocketUrl: string;
  expectedHeader: string;
}): string {
  return `
delete process.env.GEULBAT_WS_BETA_HEADER;

const expectedHeader = ${JSON.stringify(args.expectedHeader)};
const { bootstrapDaemonEntry } = await import(${JSON.stringify(args.bootstrapEntryUrl)});
let observedHeader;

await bootstrapDaemonEntry({
  loadEnv: () => {
    process.env.GEULBAT_WS_BETA_HEADER = expectedHeader;
  },
  importMain: async () => {
    const { streamResponsesOverWebSocket } = await import(${JSON.stringify(args.responsesWebSocketUrl)});
    try {
      await streamResponsesOverWebSocket({
        headers: new Headers(),
        payload: { type: 'response.create' },
        providerSessionId: 'bootstrap-probe',
        webSocketReusePolicy: {
          idleRetentionMs: 30 * 60 * 1000,
          maxConnectionLifetimeMs: 60 * 60 * 1000,
        },
        providerWebSocketSessions: {
          async acquireWebSocket(_url, headers) {
            observedHeader = headers.get('OpenAI-Beta');
            throw new Error('stop after header projection');
          },
        },
      });
    } catch {
      // The probe stops after the stream owner has projected request headers.
    }
  },
});

if (observedHeader !== expectedHeader) {
  throw new Error(\`expected OpenAI-Beta \${expectedHeader}, got \${observedHeader}\`);
}
`;
}
