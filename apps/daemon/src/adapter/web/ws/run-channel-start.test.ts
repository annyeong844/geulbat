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
import { assertRunId, type ThreadId } from '@geulbat/protocol/ids';
import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';

import { createDaemonContext } from '../../../daemon/context.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  readRunPromptInputRef,
  writeRunPromptInputRefFromStream,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import { appendTranscriptEntry } from '../../../daemon/sessions/transcript-log.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunChannelTestDaemonContext,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import {
  executeRunRequest,
  recoverDurableRunsForSocket,
} from './run-channel-start.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('executeRunRequest rejects blank prompts', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
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

void test('executeRunRequest reports missing working directories before starting a run', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await executeRunRequest({
      socket,
      requestId: 'run-start-missing-working-directory',
      request: {
        prompt: 'hello',
        workingDirectory: join(
          daemonContext.homeStateRoot,
          'missing-working-directory',
        ),
      },
      allowedPublicToolNames: undefined,
      runtimeContext: daemonContext,
    });

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'run-start-missing-working-directory',
      status: 404,
      code: 'not_found',
      message: 'working directory not found',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('executeRunRequest rejects malformed thread ids', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
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
  const daemonContext = createRunChannelTestDaemonContext();
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
  const daemonContext = createRunChannelTestDaemonContext();
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
  const daemonContext = createRunChannelTestDaemonContext();
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

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId,
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
  } finally {
    console.error = originalError;
    cleanupSocketState(socket, daemonContext);
    await rm(root, { recursive: true, force: true });
  }
});

void test('durable terminal recovery reprojects the thread snapshot and stable done cursor without rerunning', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(34);
  const runId = assertRunId('run-terminal-reprojection');

  try {
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'assistant',
      content: 'durable final answer',
      timestamp: '2026-07-18T00:00:00.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 4,
        event: {
          type: 'done',
          payload: { answer: 'durable final answer', ok: true },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const messages = socket.sentFrames.map((raw) => {
      const message: unknown = JSON.parse(raw);
      assert.equal(isRunChannelServerMessage(message), true);
      if (!isRunChannelServerMessage(message)) {
        throw new Error('invalid run channel test message');
      }
      return message;
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.type, 'run.event');
    assert.equal(messages[1]?.type, 'run.event');
    if (messages[0]?.type === 'run.event') {
      assert.equal(messages[0].event.seq, 3);
      assert.equal(messages[0].event.type, 'thread_state_persisted');
    }
    if (messages[1]?.type === 'run.event') {
      assert.equal(messages[1].event.seq, 4);
      assert.equal(messages[1].event.type, 'done');
      assert.deepEqual(messages[1].event.payload, {
        answer: 'durable final answer',
        ok: true,
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable recovery reconciles an already persisted final answer before model or tool recovery', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(35);
  const runId = assertRunId('run-transcript-terminal-reconcile');

  try {
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'user',
      content: 'finish once',
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    await appendTranscriptEntry(daemonContext.homeStateRoot, threadId, {
      role: 'assistant',
      content: 'already committed',
      timestamp: '2026-07-18T00:00:01.000Z',
      metadata: { phase: 'final_answer', sourceRunId: runId },
    });
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    const checkpoint = await daemonContext.runCheckpoints.readThread(threadId);
    assert.equal(checkpoint?.status, 'terminal');
    assert.deepEqual(checkpoint?.terminal, {
      eventCursor: 1,
      acknowledged: false,
      event: {
        type: 'done',
        payload: { answer: 'already committed', ok: true },
      },
    });
    assert.equal(socket.sentFrames.length, 2);
    const terminalMessage: unknown = JSON.parse(socket.sentFrames[1] ?? '');
    assert.equal(isRunChannelServerMessage(terminalMessage), true);
    if (
      isRunChannelServerMessage(terminalMessage) &&
      terminalMessage.type === 'run.event'
    ) {
      assert.equal(terminalMessage.event.seq, 1);
      assert.equal(terminalMessage.event.type, 'done');
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});

void test('durable terminal recovery reprojects exact terminal errors without a false success snapshot', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(36);
  const runId = assertRunId('run-terminal-error-reprojection');

  try {
    await daemonContext.runCheckpoints.startRun({
      runId,
      threadId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.settleRun({
      runId,
      threadId,
      terminal: {
        eventCursor: 3,
        event: {
          type: 'error',
          payload: { code: 'internal', message: 'durable failure' },
        },
      },
    });

    assert.equal(await recoverDurableRunsForSocket(socket, daemonContext), 1);
    assert.equal(socket.sentFrames.length, 1);
    const message: unknown = JSON.parse(socket.sentFrames[0] ?? '');
    assert.equal(isRunChannelServerMessage(message), true);
    if (isRunChannelServerMessage(message) && message.type === 'run.event') {
      assert.equal(message.event.seq, 3);
      assert.equal(message.event.type, 'error');
      assert.deepEqual(message.event.payload, {
        code: 'internal',
        message: 'durable failure',
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    await rm(daemonContext.homeStateRoot, { recursive: true, force: true });
  }
});
