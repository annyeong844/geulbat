import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPtcEpochCallbackChannel } from './epoch-callback.js';

const PRIVATE_HANDLER_PATH = ['', 'home', 'user', '.geulbat', 'path'].join('/');

const unixTest = process.platform === 'win32' ? test.skip : test;
const UNIX_SOCKET_TEMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(
    join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-callback-'),
  );
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sendFrame(socketPath: string, frame: unknown): Promise<unknown> {
  return await sendRawFrame(socketPath, `${JSON.stringify(frame)}\n`);
}

async function sendRawFrame(
  socketPath: string,
  payload: string,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newlineIndex)));
      }
    });
    socket.on('error', reject);
    socket.on('end', () => {
      if (buffer.length === 0) {
        reject(new Error('socket ended without response'));
      }
    });
  });
}

async function openSocket(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function destroyAndWaitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.destroy();
  });
}

void unixTest(
  'createPtcEpochCallbackChannel creates a private epoch socket and cleans it up',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => ({
          ok: true,
          result: { kind: 'inline', value: 'ok' },
        }),
      });

      assert.match(channel.epochId, /^[a-f0-9]{16}$/u);
      assert.match(channel.token, /^[a-f0-9]{64}$/u);
      assert.equal(dirname(channel.socketPath), channel.epochDir);
      assert.equal(channel.epochDir.startsWith(root), true);

      const epochDirStat = await stat(channel.epochDir);
      assert.equal(epochDirStat.mode & 0o777, 0o700);

      await access(channel.socketPath);
      await channel.close();

      await assert.rejects(() => access(channel.socketPath));
      await assert.rejects(() => access(channel.epochDir));
    });
  },
);

void unixTest(
  'callback channel rejects bad tokens before calling the handler',
  async () => {
    await withTempRoot(async (root) => {
      let calls = 0;
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => {
          calls += 1;
          return { ok: true, result: 'unexpected' };
        },
      });

      try {
        const response = await sendFrame(channel.socketPath, {
          requestId: 'req-1',
          token: 'bad-token',
          kind: 'read_file',
          args: { path: 'chapter.md' },
        });

        assert.deepEqual(response, {
          requestId: 'req-1',
          ok: false,
          errorCode: 'bad_capability',
          message: 'PTC callback token is invalid',
        });
        assert.equal(calls, 0);
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel ignores forged owner fields in callback frames',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async (invocation) => {
          return {
            ok: true,
            result: {
              kind: invocation.kind,
              args: invocation.args,
            },
          };
        },
      });

      try {
        const response = await sendFrame(channel.socketPath, {
          requestId: 'req-owner',
          token: channel.token,
          kind: 'read_file',
          args: { path: 'chapter.md' },
          threadId: 'thread-forged',
          stateRoot: '/forged',
          approvalScope: 'forged',
        });

        assert.deepEqual(response, {
          requestId: 'req-owner',
          ok: true,
          result: {
            kind: 'read_file',
            args: { path: 'chapter.md' },
          },
        });
        assert.doesNotMatch(
          JSON.stringify(response),
          /thread-forged|\/forged|forged/u,
        );
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel rejects oversized frames before JSON parsing',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        maxFrameBytes: 64,
        handler: async () => ({ ok: true, result: 'unexpected' }),
      });

      try {
        const response = await sendRawFrame(
          channel.socketPath,
          `${'x'.repeat(128)}\n`,
        );

        assert.deepEqual(response, {
          ok: false,
          errorCode: 'frame_too_large',
          message: 'PTC callback frame exceeds maxFrameBytes',
        });
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel accepts large frames and responses when no byte cap is configured',
  async () => {
    await withTempRoot(async (root) => {
      const largePayload = 'x'.repeat(70 * 1024);
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async (invocation) => ({
          ok: true,
          result: { payload: invocation.args },
        }),
      });

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-large-default',
            token: channel.token,
            kind: 'read_file',
            args: { payload: largePayload },
          }),
          {
            requestId: 'req-large-default',
            ok: true,
            result: { payload: { payload: largePayload } },
          },
        );
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest('callback channel enforces per-epoch callback cap', async () => {
  await withTempRoot(async (root) => {
    const channel = await createPtcEpochCallbackChannel({
      rootDir: root,
      maxCallbacks: 1,
      handler: async () => ({ ok: true, result: 'ok' }),
    });

    try {
      assert.deepEqual(
        await sendFrame(channel.socketPath, {
          requestId: 'req-1',
          token: channel.token,
          kind: 'read_file',
        }),
        { requestId: 'req-1', ok: true, result: 'ok' },
      );

      assert.deepEqual(
        await sendFrame(channel.socketPath, {
          requestId: 'req-2',
          token: channel.token,
          kind: 'read_file',
        }),
        {
          requestId: 'req-2',
          ok: false,
          errorCode: 'callback_cap_exceeded',
          message: 'PTC callback count exceeded for epoch',
        },
      );
    } finally {
      await channel.close();
    }
  });
});

void unixTest(
  'callback channel has no hidden per-epoch callback cap',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      try {
        for (let index = 0; index < 101; index += 1) {
          const requestId = `req-default-cap-${index}`;
          assert.deepEqual(
            await sendFrame(channel.socketPath, {
              requestId,
              token: channel.token,
              kind: 'read_file',
            }),
            { requestId, ok: true, result: 'ok' },
          );
        }
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest('callback channel classifies handler timeout', async () => {
  await withTempRoot(async (root) => {
    const channel = await createPtcEpochCallbackChannel({
      rootDir: root,
      callbackTimeoutMs: 10,
      handler: async () => {
        await delay(50);
        return { ok: true, result: 'late' };
      },
    });

    try {
      assert.deepEqual(
        await sendFrame(channel.socketPath, {
          requestId: 'req-timeout',
          token: channel.token,
          kind: 'read_file',
        }),
        {
          requestId: 'req-timeout',
          ok: false,
          errorCode: 'callback_timeout',
          message: 'PTC callback handler timed out',
        },
      );
    } finally {
      await channel.close();
    }
  });
});

void unixTest(
  'callback channel lets admitted long waits outlive the admission watchdog',
  async () => {
    await withTempRoot(async (root) => {
      const observed: { signal?: AbortSignal; entered?: boolean } = {};
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        callbackTimeoutMs: 10,
        handler: async (invocation) => {
          observed.signal = invocation.signal;
          observed.entered = invocation.enterLongWait();
          await delay(50);
          return { ok: true, result: 'late-ok' };
        },
      });

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-long-wait',
            token: channel.token,
            kind: 'read_file',
          }),
          { requestId: 'req-long-wait', ok: true, result: 'late-ok' },
        );
        assert.equal(observed.entered, true);
        assert.equal(observed.signal?.aborted, false);
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel keeps the admission watchdog active until long wait is entered',
  async () => {
    await withTempRoot(async (root) => {
      let resolveHandlerFinished!: () => void;
      const handlerFinished = new Promise<void>((resolve) => {
        resolveHandlerFinished = resolve;
      });
      const observed: { signal?: AbortSignal; entered?: boolean } = {};
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        callbackTimeoutMs: 10,
        handler: async (invocation) => {
          observed.signal = invocation.signal;
          await delay(50);
          observed.entered = invocation.enterLongWait();
          resolveHandlerFinished();
          return { ok: true, result: 'too-late' };
        },
      });

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-admission-timeout',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            requestId: 'req-admission-timeout',
            ok: false,
            errorCode: 'callback_timeout',
            message: 'PTC callback handler timed out',
          },
        );
        await handlerFinished;
        assert.equal(observed.entered, false);
        assert.equal(observed.signal?.aborted, true);
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel rejects connections above the open connection cap',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        maxOpenConnections: 1,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      const heldSocket = createConnection(channel.socketPath);
      await new Promise<void>((resolve, reject) => {
        heldSocket.once('connect', resolve);
        heldSocket.once('error', reject);
      });

      try {
        const response = await sendFrame(channel.socketPath, {
          requestId: 'req-over-cap',
          token: channel.token,
          kind: 'read_file',
        });

        assert.deepEqual(response, {
          ok: false,
          errorCode: 'too_many_connections',
          message: 'PTC callback open connection limit exceeded',
        });
      } finally {
        heldSocket.destroy();
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel does not retain rejected over-cap sockets',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        maxOpenConnections: 2,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      const firstHeldSocket = await openSocket(channel.socketPath);
      const secondHeldSocket = await openSocket(channel.socketPath);

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-over-cap',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            ok: false,
            errorCode: 'too_many_connections',
            message: 'PTC callback open connection limit exceeded',
          },
        );

        await destroyAndWaitForClose(firstHeldSocket);
        await delay(20);

        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-after-over-cap',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            requestId: 'req-after-over-cap',
            ok: true,
            result: 'ok',
          },
        );
      } finally {
        await destroyAndWaitForClose(firstHeldSocket);
        await destroyAndWaitForClose(secondHeldSocket);
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel releases partial-frame connections through the callback timeout policy',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        maxOpenConnections: 1,
        callbackTimeoutMs: 10,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      const heldSocket = createConnection(channel.socketPath);
      heldSocket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        heldSocket.once('connect', resolve);
        heldSocket.once('error', reject);
      });
      heldSocket.write('{"requestId":"partial"');

      try {
        await delay(50);
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-after-partial-timeout',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            requestId: 'req-after-partial-timeout',
            ok: true,
            result: 'ok',
          },
        );
      } finally {
        heldSocket.destroy();
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel has no hidden open connection cap',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      const heldSockets = await Promise.all(
        Array.from({ length: 17 }, async () => {
          const socket = createConnection(channel.socketPath);
          await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          });
          return socket;
        }),
      );

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-default-open-connections',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            requestId: 'req-default-open-connections',
            ok: true,
            result: 'ok',
          },
        );
      } finally {
        for (const socket of heldSockets) {
          socket.destroy();
        }
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel classifies handler rejection without leaking raw errors',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => {
          throw new Error(`secret ${PRIVATE_HANDLER_PATH}`);
        },
      });

      try {
        const response = await sendFrame(channel.socketPath, {
          requestId: 'req-handler-fail',
          token: channel.token,
          kind: 'read_file',
        });

        assert.deepEqual(response, {
          requestId: 'req-handler-fail',
          ok: false,
          errorCode: 'callback_handler_failed',
          message: 'PTC callback handler failed',
        });
        assert.doesNotMatch(
          JSON.stringify(response),
          /\.geulbat|secret|\/home/u,
        );
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel aborts handler signal when timeout is classified',
  async () => {
    await withTempRoot(async (root) => {
      const observed: { signal?: AbortSignal } = {};
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        callbackTimeoutMs: 10,
        handler: async (invocation) => {
          observed.signal = invocation.signal;
          await delay(50);
          return { ok: true, result: 'late' };
        },
      });

      try {
        const response = await sendFrame(channel.socketPath, {
          requestId: 'req-timeout-signal',
          token: channel.token,
          kind: 'read_file',
        });

        assert.deepEqual(response, {
          requestId: 'req-timeout-signal',
          ok: false,
          errorCode: 'callback_timeout',
          message: 'PTC callback handler timed out',
        });
        const observedSignal = observed.signal;
        assert.ok(observedSignal);
        assert.equal(observedSignal.aborted, true);
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest(
  'callback channel classifies non-serializable handler result',
  async () => {
    await withTempRoot(async (root) => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => ({ ok: true, result: circular }),
      });

      try {
        assert.deepEqual(
          await sendFrame(channel.socketPath, {
            requestId: 'req-circular',
            token: channel.token,
            kind: 'read_file',
          }),
          {
            requestId: 'req-circular',
            ok: false,
            errorCode: 'callback_result_not_serializable',
            message: 'PTC callback response is not JSON serializable',
          },
        );
      } finally {
        await channel.close();
      }
    });
  },
);

void unixTest('callback channel bounds serialized response size', async () => {
  await withTempRoot(async (root) => {
    const channel = await createPtcEpochCallbackChannel({
      rootDir: root,
      maxResponseBytes: 96,
      handler: async () => ({ ok: true, result: 'x'.repeat(256) }),
    });

    try {
      assert.deepEqual(
        await sendFrame(channel.socketPath, {
          requestId: 'req-huge-response',
          token: channel.token,
          kind: 'read_file',
        }),
        {
          requestId: 'req-huge-response',
          ok: false,
          errorCode: 'callback_response_too_large',
          message: 'PTC callback response exceeds maxResponseBytes',
        },
      );
    } finally {
      await channel.close();
    }
  });
});

void unixTest(
  'callback channel close destroys open connections and removes the epoch directory',
  async () => {
    await withTempRoot(async (root) => {
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        handler: async () => ({ ok: true, result: 'ok' }),
      });

      const socket = createConnection(channel.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });

      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
      });

      await channel.close();
      await closed;

      await assert.rejects(() => access(channel.socketPath));
      await assert.rejects(() => access(channel.epochDir));
    });
  },
);
