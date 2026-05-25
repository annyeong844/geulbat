import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  assertRunId as assertValidRunId,
  type ProjectId,
} from '@geulbat/protocol/ids';
import { createDaemonContext } from '../../../daemon/context.js';
import { DEFAULT_PROJECT_ID } from '../../../daemon/files/project-registry-state.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { attachRunChannelServer } from './run-channel.js';
import { getSocketState } from './run-channel-socket-runtime.js';

const TEST_DEV_TOKEN = 'test-token-123456';

void test('run-channel enforces websocket origin policy', async (t) => {
  const cases: Array<{
    label: string;
    origin: string;
    expected: 'open' | 'reject';
    expectedStatus?: number;
    allowedOrigins?: string;
  }> = [
    {
      label: 'accepts loopback websocket origins',
      origin: 'http://127.0.0.1:5174',
      expected: 'open',
    },
    {
      label: 'rejects non-loopback websocket origins',
      origin: 'https://evil.example',
      expected: 'reject',
      expectedStatus: 403,
    },
    {
      label: 'allows explicitly configured external websocket origins',
      origin: 'https://demo.trycloudflare.com',
      expected: 'open',
      allowedOrigins: 'https://demo.trycloudflare.com',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async () => {
      await withRunChannelServer(
        testCase.allowedOrigins !== undefined
          ? { allowedOrigins: testCase.allowedOrigins }
          : {},
        async ({ port }) => {
          if (testCase.expected === 'open') {
            await expectSocketOpen(port, testCase.origin);
            return;
          }

          const statusCode = await getSocketRejectedStatus(
            port,
            testCase.origin,
          );
          assert.equal(statusCode, testCase.expectedStatus);
        },
      );
    });
  }
});

void test('run-channel rejects non-authenticated run messages and closes the socket', async () => {
  const server = createServer();
  attachRunChannelServer(server, { runtimeContext: createDaemonContext() });
  await listen(server);

  try {
    const port = (server.address() as AddressInfo).port;
    const result = await new Promise<{
      messages: Array<{ code: string; message: string }>;
      closeCode: number;
    }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        origin: 'http://127.0.0.1:5174',
      });
      const messages: Array<{ code: string; message: string }> = [];

      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'run.start',
            requestId: 'req-no-auth',
            request: { prompt: 'hello', projectId: 'workspace' },
          }),
        );
      });
      socket.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as {
          type: string;
          code?: string;
          message?: string;
        };
        if (parsed.type === 'run.error' && parsed.code && parsed.message) {
          messages.push({ code: parsed.code, message: parsed.message });
        }
      });
      socket.once('close', (code) => resolve({ messages, closeCode: code }));
      socket.once('error', reject);
    });

    assert.equal(result.closeCode, 1008);
    assert.deepEqual(result.messages, [
      { code: 'unauthorized', message: 'websocket authentication required' },
    ]);
  } finally {
    await close(server);
  }
});

void test('run-channel preserves requestId when message dispatch rejects before validation completes', async () => {
  const daemonContext = createDaemonContext();
  const originalIsKnownProjectId =
    daemonContext.projectRegistry.isKnownProjectId;
  daemonContext.projectRegistry.isKnownProjectId = (
    _projectId: string,
  ): _projectId is ProjectId => {
    throw new Error('project registry unavailable');
  };

  try {
    await withRunChannelServer(
      { devToken: TEST_DEV_TOKEN, daemonContext },
      async ({ port }) => {
        const socket = await connectAuthenticatedSocket(
          port,
          'auth-dispatch-reject',
        );

        try {
          const response = await sendAndWaitForError(socket, {
            type: 'run.start',
            requestId: 'start-registry-throw',
            request: { prompt: 'hello', projectId: 'workspace' },
          });

          assert.deepEqual(response, {
            requestId: 'start-registry-throw',
            status: 500,
            code: 'internal',
            message: 'internal websocket error',
          });
        } finally {
          socket.close();
        }
      },
    );
  } finally {
    daemonContext.projectRegistry.isKnownProjectId = originalIsKnownProjectId;
  }
});

void test('run-channel rejects control messages from a socket that does not own the run', async (t) => {
  const cases = [
    {
      label: 'cancel',
      runId: assertValidRunId('run-owned-by-other-socket'),
      threadId: testThreadId(1),
      requestId: 'cancel-req',
      buildMessage: (runId: string) => ({
        type: 'run.cancel',
        requestId: 'cancel-req',
        request: { runId },
      }),
    },
    {
      label: 'approve',
      runId: assertValidRunId('run-owned-by-first-socket'),
      threadId: testThreadId(2),
      requestId: 'approve-req',
      buildMessage: (runId: string, threadId: string) => ({
        type: 'run.approve',
        requestId: 'approve-req',
        request: {
          callId: 'call-1',
          runId,
          threadId,
          approved: true,
          grantScope: 'once',
        },
      }),
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.label, async () => {
      await withOwnedRunChannel(
        testCase.runId,
        testCase.threadId,
        async (ctx) => {
          const owner = await connectAuthenticatedSocket(
            ctx.port,
            'auth-owner',
          );
          const other = await connectAuthenticatedSocket(
            ctx.port,
            'auth-other',
          );

          try {
            markFirstServerSocketOwnsRun(ctx.wss, testCase.runId);
            const response = await sendAndWaitForError(
              other,
              testCase.buildMessage(testCase.runId, testCase.threadId),
            );

            assert.equal(response.code, 'access_denied');
            assert.match(response.message, /socket does not own run/);
          } finally {
            owner.close();
            other.close();
          }
        },
      );
    });
  }
});

void test('run-channel aborts socket-owned active runs when the socket closes', async () => {
  const runId = assertValidRunId('run-owned-by-socket');
  const threadId = testThreadId(3);
  const abortController = new AbortController();
  await withOwnedRunChannel(
    runId,
    threadId,
    async ({ port, wss }) => {
      const client = await connectAuthenticatedSocket(port, 'auth-owner');
      try {
        markFirstServerSocketOwnsRun(wss, runId);
        const aborted = new Promise<void>((resolve) => {
          abortController.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });

        client.close();
        await aborted;
        assert.equal(abortController.signal.aborted, true);
      } finally {
        client.close();
      }
    },
    abortController,
  );
});

void test('run-channel can use an injected daemon context for socket cleanup', async () => {
  const daemonContext = createDaemonContext();
  const runId = assertValidRunId('run-owned-by-local-context');
  const threadId = testThreadId(4);
  const abortController = new AbortController();

  await withOwnedRunChannel(
    runId,
    threadId,
    async ({ port, wss }) => {
      const client = await connectAuthenticatedSocket(port, 'auth-local-owner');
      try {
        markFirstServerSocketOwnsRun(wss, runId);
        const aborted = new Promise<void>((resolve) => {
          abortController.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });

        client.close();
        await aborted;
        assert.equal(abortController.signal.aborted, true);
      } finally {
        client.close();
      }
    },
    abortController,
    daemonContext,
  );
});

void test('run-channel keeps authenticated sockets alive while pong replies arrive', async () => {
  await withRunChannelServer(
    {
      devToken: TEST_DEV_TOKEN,
      heartbeatIntervalMs: 25,
      heartbeatPongTimeoutMs: 25,
    },
    async ({ port }) => {
      const socket = await connectAuthenticatedSocket(
        port,
        'auth-heartbeat-ok',
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(socket.readyState, WebSocket.OPEN);
      } finally {
        socket.close();
      }
    },
  );
});

void test('run-channel closes dead peers that stop answering heartbeat pings', async () => {
  const runId = assertValidRunId('run-heartbeat-timeout');
  const threadId = testThreadId(5);
  const abortController = new AbortController();

  await withOwnedRunChannel(
    runId,
    threadId,
    async ({ port, wss }) => {
      const client = await connectAuthenticatedSocket(
        port,
        'auth-heartbeat-dead',
      );

      try {
        markFirstServerSocketOwnsRun(wss, runId);
        const serverSocket = Array.from(wss.clients)[0];
        assert.ok(serverSocket);
        serverSocket.ping = (() => undefined) as typeof serverSocket.ping;

        await Promise.all([
          new Promise<void>((resolve, reject) => {
            client.once('close', () => resolve());
            client.once('error', reject);
          }),
          new Promise<void>((resolve) => {
            abortController.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);

        assert.equal(abortController.signal.aborted, true);
      } finally {
        client.close();
      }
    },
    abortController,
    undefined,
    {
      heartbeatIntervalMs: 10,
      heartbeatPongTimeoutMs: 10,
    },
  );
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function withRunChannelServer<T>(
  options: {
    allowedOrigins?: string;
    devToken?: string;
    daemonContext?: ReturnType<typeof createDaemonContext>;
    heartbeatIntervalMs?: number;
    heartbeatPongTimeoutMs?: number;
  },
  run: (ctx: {
    port: number;
    wss: ReturnType<typeof attachRunChannelServer>;
    daemonContext: ReturnType<typeof createDaemonContext>;
  }) => Promise<T>,
): Promise<T> {
  const previousAllowedOrigins = process.env['GEULBAT_ALLOWED_ORIGINS'];
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  setOptionalEnv('GEULBAT_ALLOWED_ORIGINS', options.allowedOrigins);
  setOptionalEnv('GEULBAT_DEV_TOKEN', options.devToken);

  const server = createServer();
  const daemonContext = options.daemonContext ?? createDaemonContext();
  const wss = attachRunChannelServer(server, {
    runtimeContext: daemonContext,
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.heartbeatPongTimeoutMs !== undefined
      ? { heartbeatPongTimeoutMs: options.heartbeatPongTimeoutMs }
      : {}),
  });
  await listen(server);

  try {
    return await run({
      port: (server.address() as AddressInfo).port,
      wss,
      daemonContext,
    });
  } finally {
    await close(server);
    restoreEnv('GEULBAT_ALLOWED_ORIGINS', previousAllowedOrigins);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
}

async function withOwnedRunChannel<T>(
  runId: ReturnType<typeof assertValidRunId>,
  threadId: ReturnType<typeof testThreadId>,
  run: (ctx: {
    port: number;
    wss: ReturnType<typeof attachRunChannelServer>;
  }) => Promise<T>,
  abortController: AbortController = new AbortController(),
  daemonContext?: ReturnType<typeof createDaemonContext>,
  heartbeat?: {
    heartbeatIntervalMs?: number;
    heartbeatPongTimeoutMs?: number;
  },
): Promise<T> {
  return withRunChannelServer(
    {
      devToken: TEST_DEV_TOKEN,
      ...(daemonContext !== undefined ? { daemonContext } : {}),
      ...(heartbeat ?? {}),
    },
    async (ctx) => {
      const activeRuns = ctx.daemonContext.activeRuns;
      activeRuns.tryStartRun(threadId, {
        runId,
        threadId,
        projectId: DEFAULT_PROJECT_ID,
        workspaceRoot: '/tmp/workspace',
        ownerThreadId: threadId,
        abortController,
        startedAt: new Date().toISOString(),
      });

      try {
        return await run(ctx);
      } finally {
        activeRuns.finishRun(threadId, runId);
      }
    },
  );
}

async function expectSocketOpen(port: number, origin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      origin,
    });

    socket.once('open', () => {
      socket.close();
      resolve();
    });
    socket.once('unexpected-response', (_, response) => {
      reject(new Error(`unexpected status: ${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

async function getSocketRejectedStatus(
  port: number,
  origin: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      origin,
    });

    socket.once('unexpected-response', (_, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      reject(new Error('unexpected websocket open'));
    });
    socket.once('error', reject);
  });
}

async function connectAuthenticatedSocket(
  port: number,
  requestId: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      origin: 'http://127.0.0.1:5174',
    });

    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'run.auth',
          requestId,
          token: TEST_DEV_TOKEN,
        }),
      );
    });
    socket.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as {
        type: string;
        requestId?: string;
        ok?: boolean;
      };
      if (
        parsed.type === 'run.auth.ok' &&
        parsed.requestId === requestId &&
        parsed.ok === true
      ) {
        resolve(socket);
      }
    });
    socket.once('error', reject);
  });
}

function markFirstServerSocketOwnsRun(
  wss: ReturnType<typeof attachRunChannelServer>,
  runId: ReturnType<typeof assertValidRunId>,
): void {
  const firstSocket = Array.from(wss.clients)[0];
  assert.ok(firstSocket);
  getSocketState(firstSocket).activeRunIds.add(runId);
}

async function sendAndWaitForError(
  socket: WebSocket,
  message: Record<string, unknown>,
): Promise<{
  requestId: string | undefined;
  status: number | undefined;
  code: string;
  message: string;
}> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(String(raw)) as {
        type: string;
        requestId?: string;
        status?: number;
        code?: string;
        message?: string;
      };
      if (parsed.type === 'run.error' && parsed.code && parsed.message) {
        socket.off('message', onMessage);
        resolve({
          requestId: parsed.requestId,
          status: parsed.status,
          code: parsed.code,
          message: parsed.message,
        });
      }
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
    socket.send(JSON.stringify(message));
  });
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
