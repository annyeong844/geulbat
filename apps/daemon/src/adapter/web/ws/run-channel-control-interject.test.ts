import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunInterjectRequest } from '@geulbat/protocol/run-channel';

import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import {
  handleRunInterject,
  handleRunInterjectCancel,
  handleRunInterjectFlush,
} from './run-channel-control.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunInterjectBuffer,
  isInterjectFlushRequested,
  pushPendingInterject,
} from '../../../daemon/sessions/active-run-interject-buffer.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('handleRunInterject reports invalid_args for malformed text', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    await handleRunInterject(
      socket,
      'interject-invalid',
      {
        runId: testRunId('interject-invalid'),
        text: '   ',
      },
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-invalid',
      status: 400,
      code: 'invalid_args',
      message: 'text is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports not_found before ownership for missing runs', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = testRunId('interject-missing');

  try {
    await handleRunInterject(
      socket,
      'interject-missing',
      {
        runId,
        text: 'please steer this missing run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-missing',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports access_denied when socket does not own an active run', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(131);
  const runId = testRunId('interject-unowned');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);

  try {
    await handleRunInterject(
      socket,
      'interject-unowned',
      {
        runId,
        text: 'please steer this unowned run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-unowned',
      status: 403,
      code: 'access_denied',
      message: `socket does not own run: ${runId}`,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject durably appends to an owned active-run buffer', async (t) => {
  const socket = createTestSocket();
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-interject-control-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = testThreadId(132);
  const runId = testRunId('interject-owned');
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  getSocketState(socket).activeRunIds.add(runId);

  try {
    await handleRunInterject(
      socket,
      'interject-owned',
      {
        runId,
        text: '  preserve steer text  ',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'interject-owned',
      action: 'run.interject',
      ok: true,
      receivedSeq: 1,
      bufferDepth: 1,
    });
    assert.deepEqual(interject.items, [
      { receivedSeq: 1, text: '  preserve steer text  ' },
    ]);
    assert.deepEqual(
      (await daemonContext.runCheckpoints.readThread(threadId))
        ?.pendingInterjects,
      [{ receivedSeq: 1, text: '  preserve steer text  ' }],
    );
    await handleRunInterjectCancel(
      socket,
      'interject-owned-cancel',
      { runId, receivedSeq: 1 },
      daemonContext,
    );
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'interject-owned-cancel',
      action: 'run.interject.cancel',
      ok: true,
      cancelled: true,
    });
    assert.deepEqual(interject.items, []);
    assert.deepEqual(
      (await daemonContext.runCheckpoints.readThread(threadId))
        ?.pendingInterjects,
      [],
    );
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports not_found for aborted active runs', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(133);
  const runId = testRunId('interject-aborted');
  const abortController = new AbortController();
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);
  abortController.abort();

  try {
    await handleRunInterject(
      socket,
      'interject-aborted',
      {
        runId,
        text: 'please steer this aborted run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-aborted',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
    assert.deepEqual(interject.items, []);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush reports not_found for missing runs', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = testRunId('flush-missing');

  try {
    handleRunInterjectFlush(socket, 'flush-missing', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'flush-missing',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush reports access_denied when socket does not own the run', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(133);
  const runId = testRunId('flush-unowned');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);

  try {
    handleRunInterjectFlush(socket, 'flush-unowned', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'flush-unowned',
      status: 403,
      code: 'access_denied',
      message: `socket does not own run: ${runId}`,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush marks an owned queued buffer and acks flushed=true', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(134);
  const runId = testRunId('flush-owned');
  const interject = createRunInterjectBuffer();
  pushPendingInterject(interject, 'queued steer');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunInterjectFlush(socket, 'flush-owned', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'flush-owned',
      action: 'run.interject.flush',
      ok: true,
      flushed: true,
    });
    assert.equal(isInterjectFlushRequested(interject), true);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush acks flushed=false when the queue is empty', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(135);
  const runId = testRunId('flush-empty');
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunInterjectFlush(socket, 'flush-empty', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'flush-empty',
      action: 'run.interject.flush',
      ok: true,
      flushed: false,
    });
    assert.equal(isInterjectFlushRequested(interject), false);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});
