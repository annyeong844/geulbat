import test from 'node:test';
import assert from 'node:assert/strict';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { RunChildCancelRequest } from '@geulbat/protocol/run-channel';
import type { RunId } from '@geulbat/protocol/ids';

import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import {
  handleRunCancel,
  handleRunChildCancel,
} from './run-channel-control.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { createRunInterjectBuffer } from '../../../daemon/sessions/active-run-interject-buffer.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('handleRunCancel reports bad_request when runId is missing', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunCancel(
      socket,
      'cancel-missing',
      {
        runId: '' as unknown as RunId,
      } satisfies CancelRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-missing',
      status: 400,
      code: 'bad_request',
      message: 'runId is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel aborts an owned active run and sends run.control', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(11);
  const runId = 'run-cancel-owned' as RunId;
  const abortController = new AbortController();

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-owned',
      { runId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(abortController.signal.aborted, true);
    assert.equal(abortController.signal.reason, 'user_interrupt');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-owned',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel aborts the owned run thread tree, including child runs', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(211);
  const childThreadId = testThreadId(212);
  const parentRunId = 'run-cancel-parent' as RunId;
  const childRunId = 'run-cancel-child' as RunId;
  const parentAbortController = new AbortController();
  const childAbortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(ownerThreadId, {
      runId: parentRunId,
      ...makeRunContext({ threadId: ownerThreadId }),
      ownerThreadId,
      abortController: parentAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      ...makeRunContext({ threadId: childThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );
  getSocketState(socket).activeRunIds.add(parentRunId);

  try {
    handleRunCancel(
      socket,
      'cancel-tree',
      { runId: parentRunId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(parentAbortController.signal.aborted, true);
    assert.equal(parentAbortController.signal.reason, 'user_interrupt');
    assert.equal(childAbortController.signal.aborted, true);
    assert.equal(childAbortController.signal.reason, 'user_interrupt');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-tree',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunChildCancel aborts only the selected owned child subtree', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(221);
  const childThreadId = testThreadId(222);
  const siblingThreadId = testThreadId(223);
  const parentRunId = 'run-child-cancel-parent' as RunId;
  const childRunId = 'run-child-cancel-target' as RunId;
  const siblingRunId = 'run-child-cancel-sibling' as RunId;
  const parentAbortController = new AbortController();
  const childAbortController = new AbortController();
  const siblingAbortController = new AbortController();

  for (const [threadId, runId, abortController, parent] of [
    [ownerThreadId, parentRunId, parentAbortController, undefined],
    [childThreadId, childRunId, childAbortController, parentRunId],
    [siblingThreadId, siblingRunId, siblingAbortController, parentRunId],
  ] as const) {
    assert.deepEqual(
      daemonContext.activeRuns.tryStartRun(threadId, {
        runId,
        ...makeRunContext({ threadId }),
        ownerThreadId,
        abortController,
        interject: createRunInterjectBuffer(),
        startedAt: '2026-03-30T00:00:00.000Z',
        ...(parent === undefined ? {} : { parentRunId: parent }),
      }),
      { ok: true },
    );
  }
  getSocketState(socket).activeRunIds.add(parentRunId);

  try {
    handleRunChildCancel(
      socket,
      'cancel-child',
      { parentRunId, childRunId } satisfies RunChildCancelRequest,
      daemonContext,
    );

    assert.equal(parentAbortController.signal.aborted, false);
    assert.equal(childAbortController.signal.aborted, true);
    assert.equal(childAbortController.signal.reason, 'explicit_stop');
    assert.equal(siblingAbortController.signal.aborted, false);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-child',
      action: 'run.child.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
    daemonContext.activeRuns.finishRun(siblingThreadId, siblingRunId);
    daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunChildCancel keeps an active child stoppable after its owned parent finishes', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(226);
  const childThreadId = testThreadId(227);
  const parentRunId = 'run-child-cancel-finished-parent' as RunId;
  const childRunId = 'run-child-cancel-after-parent' as RunId;
  const childAbortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(ownerThreadId, {
      runId: parentRunId,
      ...makeRunContext({ threadId: ownerThreadId }),
      ownerThreadId,
      abortController: new AbortController(),
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      ...makeRunContext({ threadId: childThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );
  const socketState = getSocketState(socket);
  socketState.activeRunIds.add(parentRunId);
  socketState.ownedRunIds.add(parentRunId);
  daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);
  socketState.activeRunIds.delete(parentRunId);

  try {
    handleRunChildCancel(
      socket,
      'cancel-child-after-parent',
      { parentRunId, childRunId } satisfies RunChildCancelRequest,
      daemonContext,
    );

    assert.equal(childAbortController.signal.aborted, true);
    assert.equal(childAbortController.signal.reason, 'explicit_stop');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-child-after-parent',
      action: 'run.child.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunChildCancel rejects a child outside the owned parent', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(224);
  const otherThreadId = testThreadId(225);
  const parentRunId = 'run-child-cancel-owned-parent' as RunId;
  const otherParentRunId = 'run-child-cancel-other-parent' as RunId;
  const childRunId = 'run-child-cancel-other-child' as RunId;
  const childAbortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(otherThreadId, {
      runId: childRunId,
      ...makeRunContext({ threadId: otherThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
      parentRunId: otherParentRunId,
    }),
    { ok: true },
  );
  getSocketState(socket).activeRunIds.add(parentRunId);

  try {
    handleRunChildCancel(
      socket,
      'cancel-other-child',
      { parentRunId, childRunId } satisfies RunChildCancelRequest,
      daemonContext,
    );

    assert.equal(childAbortController.signal.aborted, false);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-other-child',
      status: 403,
      code: 'access_denied',
      message: `run is not a child of parent run: ${parentRunId}`,
    });
  } finally {
    daemonContext.activeRuns.finishRun(otherThreadId, childRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel reports not_found when the socket owns a missing run', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = 'run-cancel-missing' as RunId;
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-not-found',
      {
        runId,
      } satisfies CancelRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-not-found',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel can use an injected active-run store', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(111);
  const runId = 'run-cancel-local-store' as RunId;
  const abortController = new AbortController();

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-local-store',
      { runId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-local-store',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});
