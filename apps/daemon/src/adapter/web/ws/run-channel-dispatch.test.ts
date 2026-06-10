import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunId } from '@geulbat/protocol/ids';
import { bootstrapDaemonContext } from '../../../bootstrap-daemon-context.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { resetShellAuthFailureRateLimitForTests } from '#web/auth/auth-failure-rate-limit.js';
import {
  clearSentMessages,
  createTestSocket,
  readLastSentMessage,
} from './run-channel-test-support.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_DEV_TOKEN = 'test-token-123456';

void test('handleClientMessage rejects invalid websocket JSON', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    await handleClientMessage(socket, '{', daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      status: 400,
      code: 'bad_request',
      message: 'invalid websocket JSON',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage rejects blank requestId before auth', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: '  ',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      status: 400,
      code: 'bad_request',
      message: 'requestId is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage authenticates a socket and rejects duplicate auth', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const state = getSocketState(socket);
  state.authTimeout = setTimeout(() => undefined, 60_000);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-1',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.equal(state.authenticated, true);
    assert.equal(state.authTimeout, null);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.auth.ok',
      requestId: 'auth-1',
      ok: true,
    });

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-2',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'auth-2',
      status: 409,
      code: 'conflict',
      message: 'socket already authenticated',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage authenticates sockets that were authorized during websocket upgrade', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const state = getSocketState(socket);
  state.upgradeAuthorized = true;
  state.authTimeout = setTimeout(() => undefined, 60_000);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-cookie-upgrade',
        token: 'cookie-auth',
      }),
      daemonContext,
    );

    assert.equal(state.authenticated, true);
    assert.equal(state.authTimeout, null);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.auth.ok',
      requestId: 'auth-cookie-upgrade',
      ok: true,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage closes unauthorized sockets for invalid auth tokens', async () => {
  resetShellAuthFailureRateLimitForTests();
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  getSocketState(socket).remoteAddress = '127.0.0.31';

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-invalid',
        token: 'wrong-token-123456',
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'auth-invalid',
      status: 401,
      code: 'unauthorized',
      message: 'invalid websocket auth token',
    });
    assert.deepEqual(socket.closeCalls, [
      { code: 1008, reason: 'unauthorized' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage rate limits repeated websocket auth failures from the same client', async () => {
  resetShellAuthFailureRateLimitForTests();
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createDaemonContext();

  try {
    for (let index = 0; index < 8; index += 1) {
      const socket = createTestSocket();
      getSocketState(socket).remoteAddress = '127.0.0.41';
      await handleClientMessage(
        socket,
        JSON.stringify({
          type: 'run.auth',
          requestId: `auth-invalid-${index}`,
          token: 'wrong-token-123456',
        }),
        daemonContext,
      );

      assert.deepEqual(readLastSentMessage(socket), {
        type: 'run.error',
        requestId: `auth-invalid-${index}`,
        status: 401,
        code: 'unauthorized',
        message: 'invalid websocket auth token',
      });
      cleanupSocketState(socket, daemonContext);
    }

    const limitedSocket = createTestSocket();
    getSocketState(limitedSocket).remoteAddress = '127.0.0.41';
    await handleClientMessage(
      limitedSocket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-limited',
        token: 'wrong-token-123456',
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(limitedSocket), {
      type: 'run.error',
      requestId: 'auth-limited',
      status: 429,
      code: 'rate_limited',
      message: 'too many authentication failures; retry later',
    });
    assert.deepEqual(limitedSocket.closeCalls, [
      { code: 1008, reason: 'rate_limited' },
    ]);
    cleanupSocketState(limitedSocket, daemonContext);
  } finally {
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage closes unauthenticated sockets for run messages', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-no-auth',
        request: {
          prompt: 'hello',
          projectId: 'workspace',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-no-auth',
      status: 401,
      code: 'unauthorized',
      message: 'websocket authentication required',
    });
    assert.deepEqual(socket.closeCalls, [
      { code: 1008, reason: 'unauthorized' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage routes authenticated run.start validation errors through executeRunRequest', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-start',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-empty-prompt',
        request: {
          prompt: '   ',
          projectId: 'workspace',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-empty-prompt',
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage rejects a second same-socket run.start while another start is in flight', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-inflight',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    getSocketState(socket).runStartInFlightRequestId = 'start-first';
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-second',
        request: {
          prompt: 'hello',
          projectId: 'workspace',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-second',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has an active run',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage preserves requestId when run.cancel dispatch throws unexpectedly', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = 'run-cancel-dispatch-throw' as RunId;
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  socketState.activeRunIds.add(runId);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const originalGetRunById = daemonContext.activeRuns.getRunById;
  daemonContext.activeRuns.getRunById = (() => {
    throw new Error('boom');
  }) as typeof daemonContext.activeRuns.getRunById;

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.cancel',
        requestId: 'cancel-throw',
        request: { runId },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-throw',
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
    const dispatchLog = errors.find((entry) =>
      String(entry[0]).includes(
        '[run-channel/dispatch] unexpected websocket message dispatch error:',
      ),
    );
    assert.ok(dispatchLog);
    const logLine = String(dispatchLog[0]);
    assert.match(logLine, /messageType="run.cancel"/);
    assert.match(logLine, /requestId="cancel-throw"/);
    assert.match(logLine, /runId="run-cancel-dispatch-throw"/);
  } finally {
    console.error = originalError;
    daemonContext.activeRuns.getRunById = originalGetRunById;
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage preserves requestId when run.start setup throws unexpectedly', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();
  const originalTryStartRun = daemonContext.activeRuns.tryStartRun;
  daemonContext.activeRuns.tryStartRun = (() => {
    throw new Error('boom');
  }) as typeof daemonContext.activeRuns.tryStartRun;
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-start-throw',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-throw',
        request: {
          prompt: 'hello',
          projectId: 'workspace',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-throw',
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
    assert.equal(getSocketState(socket).runStartInFlightRequestId, null);
    const dispatchLog = errors.find((entry) =>
      String(entry[0]).includes(
        '[run-channel/dispatch] unexpected run.start dispatch error:',
      ),
    );
    assert.ok(dispatchLog);
    const logLine = String(dispatchLog[0]);
    assert.match(logLine, /messageType="run.start"/);
    assert.match(logLine, /projectId="workspace"/);
    assert.match(logLine, /requestId="start-throw"/);
  } finally {
    console.error = originalError;
    daemonContext.activeRuns.tryStartRun = originalTryStartRun;
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage can route run.start through an injected active-run store', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createDaemonContext();
  await bootstrapDaemonContext({
    projectStore: daemonContext.projectStore,
    repoRoot: process.cwd(),
  });
  const socket = createTestSocket();
  const threadId = testThreadId(141);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-dispatch-local',
      runContext: {
        threadId,
        projectId: testProjectId(),
        workspaceRoot: process.cwd(),
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-local-start',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-local-conflict',
        request: {
          prompt: 'hello',
          projectId: testProjectId(),
          threadId,
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-local-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
