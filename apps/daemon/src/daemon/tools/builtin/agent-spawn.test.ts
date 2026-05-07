import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { agentSpawnTool, createAgentSpawnTool } from './agent-spawn.js';
import { DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN } from '../../agent/subagent-concurrency.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../../test-support/run-workspace-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { assertRunId } from '@geulbat/protocol/ids';

void test('agent_spawn requires run context', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-1',
      workspaceRoot: '/tmp/workspace',
      signal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /run context is required/);
});

void test('agent_spawn rejects unexpected keys before execution', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      extra: true,
    },
    {
      callId: 'call-extra',
      workspaceRoot: '/tmp/workspace',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('agent_spawn rejects invalid subagent_type at the parser boundary', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'janitor',
    },
    {
      callId: 'call-invalid-subagent',
      workspaceRoot: '/tmp/workspace',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /subagent_type must be one of/);
});

void test('agent_spawn rejects invalid mode at the parser boundary', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      mode: 'queued',
    },
    {
      callId: 'call-invalid-mode',
      workspaceRoot: '/tmp/workspace',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /mode must be one of/);
});

void test('agent_spawn returns semantic rejection for nested child spawn in depth-1 mode', async () => {
  const childThreadId = testThreadId(1);
  const parentThreadId = testThreadId(2);
  const parentState = createRunState({
    runId: 'child-run',
    runContext: makeRunWorkspaceContext({
      threadId: childThreadId,
    }),
    parentRunId: 'top-run',
  });

  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-2',
      workspaceRoot: '/tmp/workspace',
      threadId: parentThreadId,
      runId: 'child-run',
      projectId: testProjectId(),
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'unsupported_nested_spawn');
});

void test('agent_spawn rejects worker spawn when approval routing is unavailable', async () => {
  const threadId = testThreadId(4);
  const parentState = createRunState({
    runId: 'top-run-2',
    runContext: makeRunWorkspaceContext({
      threadId,
    }),
  });

  const result = await agentSpawnTool.execute(
    {
      task: 'rewrite file',
      subagent_type: 'worker',
    },
    {
      callId: 'call-4',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-2',
      projectId: testProjectId(),
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /approval event routing/);
});

void test('agent_spawn returns launch-only ack and tracks child state in the registry', async () => {
  const threadId = testThreadId(5);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-background',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  let childStarted = false;
  let releaseChild!: () => void;
  const childFinished = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        childStarted = true;
        await childFinished;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-background',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-background',
      projectId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    childRunId: string;
    childThreadId: string;
    launchState: string;
  };
  const childRunId = assertRunId(payload.childRunId);
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'started');
  assert.equal(parentState.backgroundChildRunIds.has(childRunId), true);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (childStarted) {
      break;
    }
    await delay(10);
  }
  assert.equal(childStarted, true);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'running',
  );

  releaseChild();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!parentState.backgroundChildRunIds.has(childRunId)) {
      break;
    }
    await delay(10);
  }

  assert.equal(parentState.backgroundChildRunIds.has(childRunId), false);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'completed',
  );
});

void test('agent_spawn logs child loop throws before publishing terminal failure', async () => {
  const threadId = testThreadId(20);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-child-throw',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        throw new Error('child loop exploded');
      },
    }).startBackgroundRun,
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-child-loop-throw',
        workspaceRoot: '/tmp/workspace',
        threadId,
        runId: 'top-run-child-throw',
        projectId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
    };
    const childRunId = assertRunId(payload.childRunId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        daemonContext.childRuns.getChildRun(childRunId)?.status === 'failed'
      ) {
        break;
      }
      await delay(20);
    }

    const childRun = daemonContext.childRuns.getChildRun(childRunId);
    assert.equal(childRun?.status, 'failed');
    assert.equal(childRun?.reason, 'child_error');

    const diagnostic = errors.find(([line]) =>
      String(line).includes('subagent runAgentLoop failed'),
    );
    assert.ok(diagnostic);
    assert.match(
      String(diagnostic[0]),
      /error \[agent\/subagent-support\] subagent runAgentLoop failed:/,
    );
    assert.equal(
      (diagnostic[1] as { childRunId?: unknown })?.childRunId,
      payload.childRunId,
    );
    assert.equal(
      (diagnostic[1] as { cause?: unknown })?.cause,
      'child loop exploded',
    );
  } finally {
    console.error = originalError;
  }
});

void test('agent_spawn catches async publish failures without leaking unhandled rejections', async () => {
  const threadId = testThreadId(6);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-notify',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalEnqueue =
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult = (() => {
    throw new Error('queue unavailable');
  }) as typeof daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-notify',
        workspaceRoot: '/tmp/workspace',
        threadId,
        runId: 'top-run-notify',
        projectId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(result.ok, true);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        parentState.childRunIds.size === 0
      ) {
        break;
      }
      await delay(20);
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult =
      originalEnqueue;
  }
});

void test('agent_spawn keeps terminal notification independent from registry publish failure', async () => {
  const threadId = testThreadId(19);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-terminal-sink',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalMarkChildTerminal = daemonContext.childRuns.markChildTerminal;
  daemonContext.childRuns.markChildTerminal = (() => {
    throw new Error('registry unavailable');
  }) as typeof daemonContext.childRuns.markChildTerminal;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-terminal-sink',
        workspaceRoot: '/tmp/workspace',
        threadId,
        runId: 'top-run-terminal-sink',
        projectId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(result.ok, true);

    let backgroundResults =
      daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
        threadId,
      );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        backgroundResults.length > 0
      ) {
        break;
      }
      await delay(20);
      backgroundResults =
        daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
          threadId,
        );
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
    assert.equal(backgroundResults.length, 1);
    assert.equal(backgroundResults[0]?.terminalState, 'failed');
    assert.equal(backgroundResults[0]?.reason, 'child_error');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.childRuns.markChildTerminal = originalMarkChildTerminal;
  }
});

void test('agent_spawn lets child worker inherit parent permission mode while reusing the parent approval session', async () => {
  const threadId = testThreadId(7);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-worker',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  let capturedApprovalContext:
    | {
        sessionId: string;
        permissionMode: 'basic' | 'full_access';
        ownerRunId?: string;
        ownerThreadId?: string;
      }
    | undefined;
  let releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        capturedApprovalContext = input.approvalContext;
        await childStarted;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'rewrite file',
      subagent_type: 'worker',
    },
    {
      kind: 'agent',
      callId: 'call-worker-clamp',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-worker',
      projectId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      agentSpawnRuntime: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access',
      approvalSessionId: 'parent-approval-session',
    },
  );

  assert.equal(result.ok, true);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (capturedApprovalContext) {
      break;
    }
    await delay(10);
  }
  assert.deepEqual(capturedApprovalContext, {
    sessionId: 'parent-approval-session',
    permissionMode: 'full_access',
    ownerRunId: 'top-run-worker',
    ownerThreadId: threadId,
  });
  releaseChild();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (parentState.backgroundChildRunIds.size === 0) {
      break;
    }
    await delay(10);
  }
});

void test('agent_spawn allows four concurrent worker children under the default cap', async () => {
  const threadId = testThreadId(88);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-four-workers',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  let releaseChildren!: () => void;
  const childrenFinished = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  let startedChildren = 0;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        startedChildren += 1;
        await childrenFinished;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      testAgentSpawnTool.execute(
        {
          task: `rewrite file ${index + 1}`,
          subagent_type: 'worker',
        },
        {
          kind: 'agent',
          callId: `call-four-workers-${index + 1}`,
          workspaceRoot: '/tmp/workspace',
          threadId,
          runId: 'top-run-four-workers',
          projectId,
          runState: parentState,
          signal: new AbortController().signal,
          runSignal: new AbortController().signal,
          currentFile: undefined,
          selection: undefined,
          approvalGranted: false,
          agentSpawnRuntime: daemonContext,
          memoryIndex: undefined,
          emitAgentEvent: () => {},
          permissionMode: 'basic',
          approvalSessionId: 'parent-four-workers-session',
        },
      ),
    ),
  );
  const getBackgroundChildCount = (): number =>
    parentState.backgroundChildRunIds.size;

  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  const payloads = results.map(
    (result) =>
      JSON.parse(result.output) as {
        ok: boolean;
        childRunId: string;
        launchState: string;
      },
  );
  assert.equal(
    payloads.every((payload) => payload.ok),
    true,
  );
  assert.equal(
    payloads.every((payload) => payload.launchState === 'started'),
    true,
  );
  assert.equal(getBackgroundChildCount(), 4);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (startedChildren === 4) {
      break;
    }
    await delay(10);
  }
  assert.equal(startedChildren, 4);

  releaseChildren();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getBackgroundChildCount() === 0) {
      break;
    }
    await delay(10);
  }
  assert.equal(getBackgroundChildCount(), 0);
});

void test('agent_spawn rejects launch when the child cap is already full', async () => {
  const threadId = testThreadId(8);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-cap',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  for (
    let index = 0;
    index < DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN;
    index += 1
  ) {
    parentState.backgroundChildRunIds.add(testRunId(`child-${index}`));
  }

  const result = await agentSpawnTool.execute(
    {
      task: 'inspect files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-cap',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-cap',
      projectId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
    effectiveMax: number;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'too_many_child_runs');
  assert.equal(
    payload.effectiveMax,
    DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN,
  );
});

void test('agent_spawn applies daemon-owned subagent concurrency policy', async () => {
  const threadId = testThreadId(18);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: {
      maxConcurrentChildren: 1,
    },
  });
  const parentState = createRunState({
    runId: 'top-run-policy-cap',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  parentState.backgroundChildRunIds.add(testRunId('already-running-child'));

  const result = await agentSpawnTool.execute(
    {
      task: 'inspect files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-policy-cap',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-policy-cap',
      projectId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
    effectiveMax: number;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'too_many_child_runs');
  assert.equal(payload.effectiveMax, 1);
});

void test('agent_spawn reports timeout separately from user_interrupt', async () => {
  const threadId = testThreadId(9);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-timeout',
    runContext: makeRunWorkspaceContext({
      threadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });

  const testAgentSpawnTool = createAgentSpawnTool({
    timeoutMs: 5,
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async ({ signal }) => {
        if (!signal) {
          throw new Error('expected child run signal');
        }
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('child aborted')),
            { once: true },
          );
        });
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-timeout',
      workspaceRoot: '/tmp/workspace',
      threadId,
      runId: 'top-run-timeout',
      projectId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    childRunId: string;
  };
  const childRunId = assertRunId(payload.childRunId);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = daemonContext.childRuns.getChildRun(childRunId);
    if (snapshot?.status === 'cancelled') {
      assert.equal(snapshot.reason, 'timeout');
      return;
    }
    await delay(10);
  }

  assert.fail('expected child run to settle as timeout');
});
