import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { ThreadId } from '@geulbat/protocol/ids';

import { createDaemonContext } from '../../../daemon/context.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  readRunPromptInputRef,
  writeRunPromptInputRefFromStream,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { executeRunRequest } from './run-channel-start.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('executeRunRequest rejects blank prompts', async () => {
  const daemonContext = createDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-blank-prompt',
      request: {
        prompt: '   ',
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-blank-prompt',
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest rejects escaped working directories before starting a run', async () => {
  const daemonContext = createDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-escaped-working-directory',
      request: {
        prompt: 'hello',
        workingDirectory: '../escape',
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-escaped-working-directory',
      status: 400,
      code: 'bad_request',
      message: 'invalid workingDirectory',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest rejects malformed thread ids', async () => {
  const daemonContext = createDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-invalid-thread',
      request: {
        prompt: 'hello',
        threadId: '../bad-thread' as unknown as ThreadId,
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-invalid-thread',
      status: 400,
      code: 'bad_request',
      message: 'invalid threadId',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest does not start a run for a closed socket', async () => {
  const daemonContext = createDaemonContext();
  const socket = createTestSocket();
  const socketState = getSocketState(socket);
  socketState.closed = true;

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-closed-socket',
      request: {
        prompt: 'hello',
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.equal(readLastSentMessage(socket), undefined);
    assert.equal(socketState.activeRunIds.size, 0);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest reports conflict_active_run when the thread already has a run', async () => {
  const daemonContext = createDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(31);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-start-conflict',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: 'workspace',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-conflict',
      request: {
        prompt: 'hello',
        threadId,
      } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest deletes consumed prompt refs after active-run conflicts', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-start-prompt-ref-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const written = await writeRunPromptInputRefFromStream({
    workspaceRoot: stateRoot,
    input: Readable.from(['stored prompt']),
  });
  const socket = createTestSocket();
  const threadId = testThreadId(33);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-start-ref-conflict',
      runContext: {
        threadId,
        stateRoot,
        workingDirectory: '',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-ref-conflict',
      request: {
        promptRef: written.promptRef,
        displayPrompt: 'visible prompt',
        threadId,
      } satisfies RunStartRequest,
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-ref-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
    assert.deepEqual(
      await readRunPromptInputRef({
        workspaceRoot: stateRoot,
        promptRef: written.promptRef,
      }),
      {
        ok: false,
        code: 'not_found',
        message: 'promptRef was not found.',
      },
    );
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('executeRunRequest logs request context when foreground execution fails', async () => {
  const daemonContext = createDaemonContext();
  const root = await mkdtemp(join(tmpdir(), 'geulbat-run-start-log-'));
  const fileWorkspaceRoot = join(root, 'workspace-file');
  await writeFile(fileWorkspaceRoot, 'not a directory', 'utf8');
  const socket = createTestSocket();
  const threadId = testThreadId(32);
  const requestId = 'run-start-execute-failure';
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const runtimeContext = {
    ...daemonContext,
    homeStateRoot: fileWorkspaceRoot,
    computerFileScope: {
      root,
      browseStartPath: '',
      browseShortcuts: [],
    },
  };

  try {
    await executeRunRequest({
      socket,
      requestId,
      request: {
        prompt: 'hello',
        threadId,
      } satisfies RunRequest,
      allowedPublicToolNames: undefined,
      runtimeContext,
    });

    const executeRunLog = errors.find((entry) =>
      String(entry[0]).includes('[run-channel/execute-run] unexpected error:'),
    );
    assert.ok(executeRunLog);
    const logLine = String(executeRunLog[0]);
    assert.doesNotMatch(logLine, /projectId=/u);
    assert.match(logLine, /requestId="run-start-execute-failure"/);
    assert.match(logLine, new RegExp(`threadId="${threadId}"`, 'u'));

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (message?.type === 'run.event') {
      assert.equal(message.event.threadId, threadId);
      assert.equal(message.event.type, 'error');
      assert.deepEqual(message.event.payload, {
        code: 'internal',
        message: 'internal server error',
      });
    }
  } finally {
    console.error = originalError;
    cleanupSocketState(socket, daemonContext);
    await rm(root, { recursive: true, force: true });
  }
});
