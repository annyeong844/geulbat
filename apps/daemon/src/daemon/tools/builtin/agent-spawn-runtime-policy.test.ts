import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { assertRunId } from '@geulbat/protocol/ids';
import type { ToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import { createAgentLoopImplementationAdmission } from '../../agent/loop-implementation-admission.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createAgentSpawnDaemonContext as createDaemonContext } from '../../../test-support/agent-spawn.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { agentSpawnTool, createAgentSpawnTool } from './agent-spawn.js';

void test('agent_spawn carries one admitted child tool policy without the legacy surface', async () => {
  const threadId = testThreadId(7);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-worker',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let capturedApprovalContext:
    | {
        computerSessionId: string;
        permissionMode: 'basic' | 'full_access';
        ownerRunId?: string;
        ownerThreadId?: string;
      }
    | undefined;
  let capturedDirectRegistryNames: readonly string[] | undefined;
  let capturedAllowedRegistryNames: readonly string[] | undefined;
  let admittedToolCapabilityPolicy: ToolCapabilityPolicy | undefined;
  let capturedToolCapabilityPolicy: ToolCapabilityPolicy | undefined;
  let capturedLegacyToolSurface = false;
  let releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const baseAdmission = createAgentLoopImplementationAdmission();
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      loopImplementationAdmission: {
        async admitRun(input) {
          const selected = await baseAdmission.admitRun(input);
          if (!selected.ok) {
            return selected;
          }
          assert.ok(input.toolCapabilityPolicy);
          admittedToolCapabilityPolicy = input.toolCapabilityPolicy;
          return {
            ...selected,
            toolCapabilityPolicy: input.toolCapabilityPolicy,
          };
        },
      },
      runAgentLoop: async (input) => {
        capturedApprovalContext = input.approvalContext;
        capturedToolCapabilityPolicy = input.toolCapabilityPolicy;
        capturedLegacyToolSurface = input.toolSurface !== undefined;
        capturedDirectRegistryNames =
          input.toolCapabilityPolicy?.directRegistryNames;
        capturedAllowedRegistryNames =
          input.toolCapabilityPolicy?.allowedRegistryNames;
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
      runOwnerKind: 'root_main',
      callId: 'call-worker-clamp',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',

      workingDirectory: 'workspace',
      threadId,
      runId: 'top-run-worker',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access',
      computerSessionId: 'parent-approval-session',
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
    computerSessionId: 'parent-approval-session',
    permissionMode: 'full_access',
    ownerRunId: 'top-run-worker',
    ownerThreadId: threadId,
  });
  assert.equal(capturedToolCapabilityPolicy, admittedToolCapabilityPolicy);
  assert.equal(capturedLegacyToolSurface, false);
  const expectedWorkerToolNames = [
    'inspect_git',
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'write_file',
    'apply_patch',
    'manage_files',
    'agent_wait',
    'agent_stop',
    'agent_set_priority',
    'agent_retry',
    'submit_result_report',
  ].sort();
  assert.deepEqual(capturedDirectRegistryNames, expectedWorkerToolNames);
  assert.deepEqual(capturedAllowedRegistryNames, expectedWorkerToolNames);
  assert.equal(capturedDirectRegistryNames?.includes('exec_command'), false);
  releaseChild();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (parentState.backgroundChildRunIds.size === 0) {
      break;
    }
    await delay(10);
  }
});

void test('agent_spawn starts three Ultra worker children and queues the fourth', async () => {
  const threadId = testThreadId(88);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-four-workers',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let releaseChildren!: () => void;
  const childrenFinished = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  let startedChildren = 0;
  const readStartedChildren = (): number => startedChildren;
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
          runOwnerKind: 'root_main',
          callId: `call-four-workers-${index + 1}`,
          providerRunSelection:
            TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
          stateRoot: '/tmp/home-state',

          workingDirectory: 'workspace',
          threadId,
          runId: 'top-run-four-workers',
          runState: parentState,
          signal: new AbortController().signal,
          runSignal: new AbortController().signal,
          currentFile: undefined,
          selection: undefined,
          approvalGranted: false,
          runtimeServices: daemonContext,
          memoryIndex: undefined,
          emitAgentEvent: () => {},
          permissionMode: 'basic',
          ultraReasoning: true,
          computerSessionId: 'parent-four-workers-session',
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
    payloads.filter((payload) => payload.launchState === 'started').length,
    3,
  );
  assert.equal(
    payloads.filter((payload) => payload.launchState === 'queued').length,
    1,
  );
  assert.equal(getBackgroundChildCount(), 3);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readStartedChildren() === 3) {
      break;
    }
    await delay(10);
  }
  assert.equal(readStartedChildren(), 3);

  releaseChildren();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      Number(readStartedChildren()) === 4 &&
      getBackgroundChildCount() === 0
    ) {
      break;
    }
    await delay(10);
  }
  assert.equal(readStartedChildren(), 4);
  assert.equal(getBackgroundChildCount(), 0);
});

void test('agent_spawn Ultra policy queues launch when existing active children exceed capacity', async () => {
  const threadId = testThreadId(8);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-cap',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  for (let index = 0; index < 12; index += 1) {
    parentState.backgroundChildRunIds.add(testRunId(`child-${index}`));
  }
  let launched = false;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: async () => {
      launched = true;
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          childRunId: 'started-child',
          childThreadId: 'started-thread',
          subagentType: 'explorer',
          launchState: 'started',
        }),
      };
    },
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'inspect files',
      subagent_type: 'explorer',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-cap',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'workspace',
      threadId,
      runId: 'top-run-cap',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'basic',
      ultraReasoning: true,
      computerSessionId: 'default-policy-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    childRunId?: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'queued');
  assert.equal(typeof payload.childRunId, 'string');
  assert.equal(launched, false);
});

void test('agent_spawn durably queues a launch blocked by daemon-owned capacity', async () => {
  const threadId = testThreadId(18);
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: {
      maxConcurrentChildren: 1,
    },
  });
  const parentState = createRunState({
    runId: 'top-run-policy-cap',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
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
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-policy-cap',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'policy-cap-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    childRunId?: string;
    childThreadId?: string;
    deferReason?: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'queued');
  assert.equal(payload.deferReason, 'configured_capacity');
  assert.equal(typeof payload.childRunId, 'string');
  assert.equal(typeof payload.childThreadId, 'string');
});

void test(
  'agent_spawn reports timeout separately from user_interrupt',
  { timeout: 10_000 },
  async (t) => {
    const threadId = testThreadId(9);
    const daemonContext = createDaemonContext();
    const parentState = createRunState({
      runId: 'top-run-timeout',
      runContext: makeRunContext({
        threadId,
        stateRoot: '/tmp/home-state',
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
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-timeout',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'timeout-session',
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
    };
    const childRunId = assertRunId(payload.childRunId);

    let childRuns = daemonContext.childRuns.getChildRuns([childRunId]);
    assert.equal(childRuns.records.length, 1);
    while (true) {
      const snapshot = childRuns.records[0];
      assert.ok(snapshot);
      if (snapshot.completedAt !== null) {
        assert.equal(snapshot.status, 'cancelled');
        assert.equal(snapshot.reason, 'timeout');
        return;
      }
      await daemonContext.childRuns.waitForRevisionChange(
        childRuns.revision,
        t.signal,
      );
      childRuns = daemonContext.childRuns.getChildRuns([childRunId]);
      assert.equal(childRuns.records.length, 1);
    }
  },
);
