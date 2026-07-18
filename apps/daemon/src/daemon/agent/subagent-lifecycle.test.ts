import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createDaemonContext } from '../context.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { TEST_CHILD_MODEL_REGISTRATION } from '../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from '../runtime-contracts.js';
import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type {
  SubagentLaunchReservation,
  SubagentType,
} from '../subagent-runtime-contracts.js';
import { createRunState } from './runtime/run-state.js';
import { beginBackgroundChildLifecycle } from './subagent-lifecycle.js';

function startTestBackgroundChildLifecycle(args: {
  testLabel: string;
  ownerThreadId: number;
  childThreadId: number;
  parentRunId: string;
  childRunId: string;
  subagentType?: SubagentType;
  timeoutMs?: number;
  launchReservation?: SubagentLaunchReservation;
  emitAgentEvent?: (event: AgentEvent) => void;
  finish?: () => void;
  runtimeServices?: AgentRuntimeServices;
  captureParentRunState?: (
    parentRunState: ReturnType<typeof createRunState>,
  ) => void;
}) {
  const runtimeServices = args.runtimeServices ?? createDaemonContext();
  const ownerThreadId = testThreadId(args.ownerThreadId);
  const childThreadId = testThreadId(args.childThreadId);
  const parentRunId = testRunId(args.parentRunId);
  const childRunId = testRunId(args.childRunId);
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId: ownerThreadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const childRunState = createRunState({
    runId: childRunId,
    runContext: makeRunContext({
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
    }),
    parentRunId,
  });
  args.captureParentRunState?.(parentRunState);
  let finishCount = 0;
  const emittedEvents: AgentEvent[] = [];
  const finish =
    args.finish ??
    (() => {
      finishCount += 1;
    });
  const emitAgentEvent =
    args.emitAgentEvent ??
    ((event: AgentEvent) => {
      emittedEvents.push(event);
    });

  const lifecycle = beginBackgroundChildLifecycle({
    subagentType: args.subagentType ?? 'worker',
    parentRunId,
    ownerThreadId,
    startedChildRun: {
      runId: childRunId,
      threadId: childThreadId,
      runState: childRunState,
      finish,
    },
    parentRunState,
    runtimeServices,
    launchReservation: args.launchReservation,
    ...TEST_CHILD_MODEL_REGISTRATION,
    emitAgentEvent,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });

  return {
    runtimeServices,
    ownerThreadId,
    childThreadId,
    parentRunId,
    childRunId,
    parentRunState,
    childRunState,
    lifecycle,
    emittedEvents,
    getFinishCount() {
      return finishCount;
    },
  };
}

function captureConsoleError(): {
  calls: unknown[][];
  restore: () => void;
} {
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console.error = originalError;
    },
  };
}

function assertLifecycleErrorLog(
  calls: unknown[][],
  label: string,
  detail: string,
): void {
  assert.equal(calls.length, 1);
  const [line, loggedDetail] = calls[0] ?? [];
  if (typeof line !== 'string') {
    assert.fail('expected lifecycle logger to write a string message');
  }
  assert.ok(line.includes(`[agent/subagent-lifecycle] ${label} failed:`), line);
  assert.equal(loggedDetail, detail);
}

void test('beginBackgroundChildLifecycle registers child run and terminal publication cleans parent handles', () => {
  let releaseCount = 0;
  const {
    runtimeServices,
    ownerThreadId,
    childThreadId,
    parentRunId,
    childRunId,
    parentRunState,
    lifecycle,
    emittedEvents,
    getFinishCount,
  } = startTestBackgroundChildLifecycle({
    testLabel: 'subagent-lifecycle',
    ownerThreadId: 61,
    childThreadId: 62,
    parentRunId: 'lifecycle-parent',
    childRunId: 'lifecycle-child',
    subagentType: 'explorer',
    launchReservation: {
      release() {
        releaseCount += 1;
      },
    },
    timeoutMs: 60_000,
  });

  assert.equal(releaseCount, 1);
  assert.equal(parentRunState.childRunIds.has(childRunId), true);
  assert.equal(parentRunState.backgroundChildRunIds.has(childRunId), true);
  assert.equal(
    runtimeServices.childRuns.getChildRun(childRunId)?.status,
    'running',
  );
  assert.deepEqual(emittedEvents, [
    {
      type: 'subagent_spawned',
      payload: {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType: 'explorer',
        modelId: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        selectionSource: 'inherited',
      },
    },
  ]);

  lifecycle.publishTerminalOutcome({
    terminalState: 'completed',
    terminalReason: null,
    terminalResult: 'child done',
  });

  assert.equal(getFinishCount(), 1);
  assert.equal(parentRunState.childRunIds.has(childRunId), false);
  assert.equal(parentRunState.backgroundChildRunIds.has(childRunId), false);
  const terminalSnapshot = runtimeServices.childRuns.getChildRun(childRunId);
  assert.equal(terminalSnapshot?.status, 'completed');
  assert.equal(terminalSnapshot?.result, 'child done');
  assert.equal(terminalSnapshot?.reason, null);
  const [backgroundResult] =
    runtimeServices.backgroundNotifications.consumeThreadBackgroundResults(
      ownerThreadId,
    );
  assert.equal(backgroundResult?.parentRunId, parentRunId);
  assert.equal(backgroundResult?.childRunId, childRunId);
  assert.equal(backgroundResult?.terminalState, 'completed');
  assert.equal(backgroundResult?.result, 'child done');
  // No model rounds ran, so no usage rides on the terminal record.
  assert.equal(backgroundResult?.usage, undefined);
  assert.equal(typeof backgroundResult?.elapsedMs, 'number');
});

void test('publishTerminalOutcome carries the child run usage totals for drill-down', () => {
  const {
    runtimeServices,
    ownerThreadId,
    childThreadId,
    childRunState,
    lifecycle,
  } = startTestBackgroundChildLifecycle({
    testLabel: 'subagent-lifecycle-usage',
    ownerThreadId: 67,
    childThreadId: 68,
    parentRunId: 'lifecycle-usage-parent',
    childRunId: 'lifecycle-usage-child',
    subagentType: 'explorer',
  });

  childRunState.usageTotals.inputTokens += 120;
  childRunState.usageTotals.outputTokens += 30;
  childRunState.usageTotals.cachedInputTokens += 100;

  lifecycle.publishTerminalOutcome({
    terminalState: 'completed',
    terminalReason: null,
    terminalResult: 'child done',
  });

  const [backgroundResult] =
    runtimeServices.backgroundNotifications.consumeThreadBackgroundResults(
      ownerThreadId,
    );
  assert.deepEqual(backgroundResult?.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 100,
  });
  assert.equal(typeof backgroundResult?.elapsedMs, 'number');
  assert.ok((backgroundResult?.elapsedMs ?? -1) >= 0);
  // 드릴다운은 차일드 스레드 identity가 있어야 열린다
  assert.equal(backgroundResult?.childThreadId, childThreadId);
  // 세션 뷰어 헤더가 모델·사고 강도를 보여줄 수 있도록 pin을 나른다
  assert.equal(backgroundResult?.modelId, 'gpt-5.6-sol');
  assert.equal(backgroundResult?.reasoningEffort, 'medium');
});

void test('beginBackgroundChildLifecycle forwards timeout aborts to the child run', async () => {
  const { childRunState, lifecycle } = startTestBackgroundChildLifecycle({
    testLabel: 'subagent-lifecycle-timeout',
    ownerThreadId: 63,
    childThreadId: 64,
    parentRunId: 'lifecycle-timeout-parent',
    childRunId: 'lifecycle-timeout-child',
    timeoutMs: 5,
  });

  await delay(20);

  assert.equal(lifecycle.isTimedOut(), true);
  assert.equal(childRunState.abortController.signal.aborted, true);
  assert.equal(childRunState.abortController.signal.reason, 'child timeout');

  lifecycle.publishTerminalOutcome({
    terminalState: 'cancelled',
    terminalReason: 'timeout',
    terminalResult: 'sub-agent cancelled',
  });
});

void test('beginBackgroundChildLifecycle has no timeout unless one is explicitly configured', async () => {
  const { childRunState, lifecycle } = startTestBackgroundChildLifecycle({
    testLabel: 'subagent-lifecycle-no-timeout',
    ownerThreadId: 65,
    childThreadId: 66,
    parentRunId: 'lifecycle-no-timeout-parent',
    childRunId: 'lifecycle-no-timeout-child',
  });

  await delay(20);

  assert.equal(lifecycle.isTimedOut(), false);
  assert.equal(childRunState.abortController.signal.aborted, false);

  lifecycle.publishTerminalOutcome({
    terminalState: 'completed',
    terminalReason: null,
    terminalResult: 'sub-agent completed',
  });
});

void test('beginBackgroundChildLifecycle cleans parent handles when daemon child registry registration fails', () => {
  const runtimeServices = createDaemonContext();
  runtimeServices.childRuns.registerChildRun = () => {
    throw new Error('registry exploded');
  };
  let releaseCount = 0;
  let finishCount = 0;
  let capturedParentRunState: ReturnType<typeof createRunState> | undefined;

  assert.throws(
    () =>
      startTestBackgroundChildLifecycle({
        testLabel: 'subagent-lifecycle-registry-failure',
        ownerThreadId: 71,
        childThreadId: 72,
        parentRunId: 'lifecycle-registry-failure-parent',
        childRunId: 'lifecycle-registry-failure-child',
        runtimeServices,
        launchReservation: {
          release() {
            releaseCount += 1;
          },
        },
        finish() {
          finishCount += 1;
        },
        captureParentRunState(parentRunState) {
          capturedParentRunState = parentRunState;
        },
      }),
    /registry exploded/,
  );

  const childRunId = testRunId('lifecycle-registry-failure-child');

  assert.equal(releaseCount, 1);
  assert.equal(finishCount, 1);
  assert.equal(capturedParentRunState?.childRunIds.has(childRunId), false);
  assert.equal(
    capturedParentRunState?.backgroundChildRunIds.has(childRunId),
    false,
  );
  assert.equal(runtimeServices.childRuns.getChildRun(childRunId), undefined);
});

void test('beginBackgroundChildLifecycle cleans lifecycle state when spawn event emission fails', () => {
  let releaseCount = 0;
  let finishCount = 0;
  let capturedParentRunState: ReturnType<typeof createRunState> | undefined;
  const runtimeServices = createDaemonContext();

  assert.throws(() => {
    startTestBackgroundChildLifecycle({
      testLabel: 'subagent-lifecycle-emit-failure',
      ownerThreadId: 73,
      childThreadId: 74,
      parentRunId: 'lifecycle-emit-failure-parent',
      childRunId: 'lifecycle-emit-failure-child',
      runtimeServices,
      launchReservation: {
        release() {
          releaseCount += 1;
        },
      },
      finish() {
        finishCount += 1;
      },
      captureParentRunState(parentRunState) {
        capturedParentRunState = parentRunState;
      },
      emitAgentEvent() {
        throw new Error('emit exploded');
      },
    });
  }, /emit exploded/);

  const childRunId = testRunId('lifecycle-emit-failure-child');
  const childRun = runtimeServices.childRuns.getChildRun(childRunId);

  assert.equal(releaseCount, 1);
  assert.equal(finishCount, 1);
  assert.equal(capturedParentRunState?.childRunIds.has(childRunId), false);
  assert.equal(
    capturedParentRunState?.backgroundChildRunIds.has(childRunId),
    false,
  );
  assert.equal(childRun?.status, 'failed');
  assert.equal(childRun?.reason, 'child_error');
  assert.equal(childRun?.result, 'sub-agent launch failed');
});

void test('beginBackgroundChildLifecycle logs finish failures without blocking terminal publication', () => {
  const consoleError = captureConsoleError();
  try {
    const {
      runtimeServices,
      ownerThreadId,
      childRunId,
      parentRunState,
      lifecycle,
    } = startTestBackgroundChildLifecycle({
      testLabel: 'subagent-lifecycle-finish-failure',
      ownerThreadId: 67,
      childThreadId: 68,
      parentRunId: 'lifecycle-finish-failure-parent',
      childRunId: 'lifecycle-finish-failure-child',
      finish() {
        throw new Error('finish exploded');
      },
    });

    lifecycle.publishTerminalOutcome({
      terminalState: 'completed',
      terminalReason: null,
      terminalResult: 'child done despite finish failure',
    });

    assert.equal(parentRunState.childRunIds.has(childRunId), false);
    assert.equal(parentRunState.backgroundChildRunIds.has(childRunId), false);
    const terminalSnapshot = runtimeServices.childRuns.getChildRun(childRunId);
    assert.equal(terminalSnapshot?.status, 'completed');
    assert.equal(terminalSnapshot?.result, 'child done despite finish failure');
    const [backgroundResult] =
      runtimeServices.backgroundNotifications.consumeThreadBackgroundResults(
        ownerThreadId,
      );
    assert.equal(backgroundResult?.childRunId, childRunId);
    assert.equal(backgroundResult?.terminalState, 'completed');
    assert.equal(backgroundResult?.result, 'child done despite finish failure');
    assertLifecycleErrorLog(
      consoleError.calls,
      'finish managed child run',
      'finish exploded',
    );
  } finally {
    consoleError.restore();
  }
});

void test('beginBackgroundChildLifecycle logs deregister failures without blocking finish or terminal publication', () => {
  const consoleError = captureConsoleError();
  try {
    const {
      runtimeServices,
      ownerThreadId,
      childRunId,
      parentRunState,
      lifecycle,
      getFinishCount,
    } = startTestBackgroundChildLifecycle({
      testLabel: 'subagent-lifecycle-deregister-failure',
      ownerThreadId: 69,
      childThreadId: 70,
      parentRunId: 'lifecycle-deregister-failure-parent',
      childRunId: 'lifecycle-deregister-failure-child',
    });
    const originalChildDelete = parentRunState.childRunIds.delete;
    parentRunState.childRunIds.delete = () => {
      throw new Error('deregister exploded');
    };

    try {
      lifecycle.publishTerminalOutcome({
        terminalState: 'completed',
        terminalReason: null,
        terminalResult: 'child done despite deregister failure',
      });
    } finally {
      parentRunState.childRunIds.delete = originalChildDelete;
    }

    assert.equal(getFinishCount(), 1);
    const terminalSnapshot = runtimeServices.childRuns.getChildRun(childRunId);
    assert.equal(terminalSnapshot?.status, 'completed');
    assert.equal(
      terminalSnapshot?.result,
      'child done despite deregister failure',
    );
    const [backgroundResult] =
      runtimeServices.backgroundNotifications.consumeThreadBackgroundResults(
        ownerThreadId,
      );
    assert.equal(backgroundResult?.childRunId, childRunId);
    assert.equal(backgroundResult?.terminalState, 'completed');
    assert.equal(
      backgroundResult?.result,
      'child done despite deregister failure',
    );
    assertLifecycleErrorLog(
      consoleError.calls,
      'deregister background child handle',
      'deregister exploded',
    );
  } finally {
    consoleError.restore();
  }
});
