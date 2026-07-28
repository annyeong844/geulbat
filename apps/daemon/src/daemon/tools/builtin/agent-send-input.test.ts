import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentSpawnTool } from './agent-spawn.js';
import {
  agentSendInputTool,
  createAgentSendInputTool,
} from './agent-send-input.js';
import { agentWaitTool } from './agent-wait.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import {
  composeAgentLoopUserPrompt,
  createAgentLoopPromptPort,
} from '../../agent/loop-prompt.js';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
  type RunId,
} from '@geulbat/protocol/ids';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';

async function waitForChildStatus(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  childRunId: RunId;
  status: 'completed' | 'failed' | 'cancelled';
}): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      args.daemonContext.childRuns.getChildRun(args.childRunId)?.status ===
      args.status
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error(`child ${args.childRunId} did not reach ${args.status}`);
}

async function waitForChildCheckpointTerminal(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  childThreadId: ReturnType<typeof assertValidThreadId>;
}): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      (await args.daemonContext.runCheckpoints.readThread(args.childThreadId))
        ?.status === 'terminal'
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error(
    `child thread ${args.childThreadId} checkpoint did not become terminal`,
  );
}

async function createDurableAgentToolTestContext(stateRoot: string) {
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  return {
    daemonContext: createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: runtimeStateStore,
    }),
    runtimeStateStore,
  };
}

void test('agent_send_input rejects malformed handles and blank tasks at the parser boundary', async () => {
  const malformedHandle = await agentSendInputTool.execute(
    {
      child_run_id: 'run with spaces',
      task: 'follow-up',
    },
    {
      callId: 'call-send-input-malformed-handle',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(malformedHandle.ok, false);
  assert.equal(malformedHandle.errorCode, 'invalid_args');
  assert.match(malformedHandle.error ?? '', /child_run_id.*valid child run id/);

  const blankTask = await agentSendInputTool.execute(
    {
      child_run_id: testRunId('send-input-parser-boundary-child'),
      task: '   ',
    },
    {
      callId: 'call-send-input-blank-task',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(blankTask.ok, false);
  assert.equal(blankTask.errorCode, 'invalid_args');
  assert.match(blankTask.error ?? '', /task.*required/);
});

void test('agent_send_input continues the same child thread across top-level runs', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-send-input-'));
  const threadId = testThreadId(31);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);
  const outputs = ['first child answer', 'second child answer'];

  const startBackgroundRun = createSubagentRunLauncher({
    runAgentLoop: async () => {
      const next = outputs.shift();
      assert.ok(next);
      return {
        ok: true,
        finalProse: next,
      };
    },
  }).startBackgroundRun;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun,
  });
  const testAgentSendInputTool = createAgentSendInputTool({
    startBackgroundRun,
  });

  try {
    const firstParentState = createRunState({
      runId: 'top-run-parent-1',
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'first task',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        threadId,
        runId: 'top-run-parent-1',
        runState: firstParentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-seed-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(spawned.ok, true);
    const spawnPayload = JSON.parse(spawned.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertValidRunId(spawnPayload.childRunId);
    assert.equal(spawnPayload.ok, true);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    const secondParentState = createRunState({
      runId: 'top-run-parent-2',
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
    });
    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
        task: 'second task',
      },
      {
        callId: 'call-continue',
        stateRoot,
        threadId,
        runId: 'top-run-parent-2',
        runState: secondParentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-continue-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(continued.ok, true);
    const continuePayload = JSON.parse(continued.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
      launchState: string;
      modelId: string;
      reasoningEffort: string;
      selectionSource: string;
    };
    assert.deepEqual(continuePayload, {
      ok: true,
      childRunId: spawnPayload.childRunId,
      childThreadId: spawnPayload.childThreadId,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      selectionSource: 'inherited',
    });

    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    const transcript = await readTranscriptEntries(
      stateRoot,
      spawnPayload.childThreadId,
    );
    assert.deepEqual(
      transcript.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
      [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'first child answer' },
        { role: 'user', content: 'second task' },
        { role: 'assistant', content: 'second child answer' },
      ],
    );
    assert.equal(transcript[1]?.metadata?.sourceRunId, spawnPayload.childRunId);
    assert.equal(transcript[3]?.metadata?.sourceRunId, spawnPayload.childRunId);

    const waited = await agentWaitTool.execute(
      {
        child_run_ids: [spawnPayload.childRunId],
      },
      {
        callId: 'call-wait-after-continuation',
        stateRoot,
        runId: 'top-run-parent-2',
        threadId,
        runtimeServices: daemonContext,
        signal: new AbortController().signal,
      },
    );
    assert.equal(waited.ok, true);
    const waitPayload = JSON.parse(waited.output) as {
      completed: Array<{ childRunId: string; result: string }>;
    };
    assert.equal(waitPayload.completed[0]?.childRunId, spawnPayload.childRunId);
    assert.equal(waitPayload.completed[0]?.result, 'second child answer');
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input allows child runs to continue nested child handles', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-nested-'),
  );
  const childThreadId = testThreadId(35);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);
  const outputs = ['nested seed answer', 'nested follow-up answer'];

  const startBackgroundRun = createSubagentRunLauncher({
    runAgentLoop: async () => {
      const next = outputs.shift();
      assert.ok(next);
      return {
        ok: true,
        finalProse: next,
      };
    },
  }).startBackgroundRun;
  const nestedSpawnTool = createAgentSpawnTool({
    startBackgroundRun,
  });
  const nestedSendInputTool = createAgentSendInputTool({
    startBackgroundRun,
  });

  try {
    const childRunState = createRunState({
      runId: 'child-parent-run',
      runContext: makeRunContext({
        threadId: childThreadId,
        stateRoot,
      }),
      parentRunId: 'top-run-parent',
    });
    const spawned = await nestedSpawnTool.execute(
      {
        task: 'nested seed',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-nested-spawn',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        threadId: childThreadId,
        runId: 'child-parent-run',
        runState: childRunState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-nested-seed-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(spawned.ok, true);
    const spawnPayload = JSON.parse(spawned.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
    };
    const nestedChildRunId = assertValidRunId(spawnPayload.childRunId);
    assert.equal(spawnPayload.ok, true);
    await waitForChildStatus({
      daemonContext,
      childRunId: nestedChildRunId,
      status: 'completed',
    });

    const continued = await nestedSendInputTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
        task: 'nested follow-up',
      },
      {
        callId: 'call-nested-continue',
        stateRoot,
        threadId: childThreadId,
        runId: 'child-parent-run-2',
        runState: createRunState({
          runId: 'child-parent-run-2',
          runContext: makeRunContext({
            threadId: childThreadId,
            stateRoot,
          }),
          parentRunId: 'top-run-parent',
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-nested-continue-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(continued.ok, true);
    const continuePayload = JSON.parse(continued.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
      launchState: string;
      modelId: string;
      reasoningEffort: string;
      selectionSource: string;
    };
    assert.deepEqual(continuePayload, {
      ok: true,
      childRunId: spawnPayload.childRunId,
      childThreadId: spawnPayload.childThreadId,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      selectionSource: 'inherited',
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (outputs.length === 0) {
        break;
      }
      await delay(10);
    }
    assert.equal(outputs.length, 0);
    await waitForChildStatus({
      daemonContext,
      childRunId: nestedChildRunId,
      status: 'completed',
    });
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input rejects a child handle that is still running', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-busy-'),
  );
  const threadId = testThreadId(32);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);
  let releaseChild!: () => void;
  const childBlocked = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        await childBlocked;
        return {
          ok: true,
          finalProse: 'done',
        };
      },
    }).startBackgroundRun,
  });

  try {
    const parentState = createRunState({
      runId: 'top-run-parent-busy',
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'busy task',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn-busy',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        threadId,
        runId: 'top-run-parent-busy',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-busy-seed-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(spawned.ok, true);
    const spawnPayload = JSON.parse(spawned.output) as {
      childRunId: string;
    };
    const childRunId = assertValidRunId(spawnPayload.childRunId);
    const rejected = await agentSendInputTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
        task: 'follow-up',
      },
      {
        callId: 'call-continue-busy',
        stateRoot,
        threadId,
        runId: 'top-run-parent-busy-2',
        runState: createRunState({
          runId: 'top-run-parent-busy-2',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'send-input-busy-continue-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(rejected.ok, true);
    const payload = JSON.parse(rejected.output) as {
      ok: boolean;
      launchState: string;
      errorCode: string;
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.launchState, 'rejected');
    assert.equal(payload.errorCode, 'invalid_args');
    releaseChild();
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input forwards child approval events through the shared child runner path', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-approval-'),
  );
  const threadId = testThreadId(33);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: true,
        finalProse: 'seed child answer',
      }),
    }).startBackgroundRun,
  });

  try {
    const seeded = await testAgentSpawnTool.execute(
      {
        task: 'seed child',
        subagent_type: 'worker',
      },
      {
        kind: 'agent',
        runOwnerKind: 'root_main',
        callId: 'call-seed-child',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        workingDirectory: 'workspace',
        threadId,
        runId: 'top-run-seed',
        runState: createRunState({
          runId: 'top-run-seed',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        runtimeServices: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        computerSessionId: 'session-seed',
      },
    );

    assert.equal(seeded.ok, true);
    const seededPayload = JSON.parse(seeded.output) as {
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertValidRunId(seededPayload.childRunId);
    const childThreadId = assertValidThreadId(seededPayload.childThreadId);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    const emittedTypes: string[] = [];
    const emittedPayloads: Array<{ type: string; payload: unknown }> = [];
    const testAgentSendInputTool = createAgentSendInputTool({
      startBackgroundRun: createSubagentRunLauncher({
        runAgentLoop: async (input) => {
          input.onEvent({
            type: 'approval_required',
            payload: {
              callId: 'call-child-approval',
              runId: childRunId,
              threadId: childThreadId,
              toolName: 'write_file',
              approvalClass: 'write_file',
              permissionMode: 'basic',
              argumentsPreview: {
                path: 'draft.md',
              },
              sideEffectLevel: 'write',
            },
          });
          assert.equal(
            daemonContext.childRuns.getChildRun(childRunId)?.status,
            'approval_pending',
          );
          return {
            ok: true,
            finalProse: 'continued child answer',
          };
        },
      }).startBackgroundRun,
    });
    await daemonContext.runCheckpoints.startRun({
      runId: assertValidRunId('top-run-continue'),
      threadId,
      request: { workingDirectory: 'workspace', permissionMode: 'basic' },
    });

    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: seededPayload.childRunId,
        task: 'continue child',
      },
      {
        kind: 'agent',
        runOwnerKind: 'root_main',
        callId: 'call-continue-approval',
        stateRoot,
        workingDirectory: 'workspace',
        threadId,
        runId: 'top-run-continue',
        runState: createRunState({
          runId: 'top-run-continue',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        computerSessionId: 'session-continue',
        permissionMode: 'basic',
        runtimeServices: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: (event) => {
          emittedTypes.push(event.type);
          emittedPayloads.push({ type: event.type, payload: event.payload });
        },
      },
    );

    assert.equal(continued.ok, true);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });
    await waitForChildCheckpointTerminal({
      daemonContext,
      childThreadId,
    });

    assert.deepEqual(emittedTypes.slice(0, 3), [
      'subagent_spawned',
      'subagent_approval_required',
      'approval_required',
    ]);
    const approvalBridgeRuntime = (
      emittedPayloads[1]?.payload as {
        runtime?: { observedAt?: unknown };
      }
    ).runtime;
    const approvalBridgeObservedAt = approvalBridgeRuntime?.observedAt;
    assert.equal(typeof approvalBridgeObservedAt, 'string');
    assert.equal(
      Number.isNaN(Date.parse(approvalBridgeObservedAt as string)),
      false,
    );
    assert.deepEqual(emittedPayloads[1], {
      type: 'subagent_approval_required',
      payload: {
        parentRunId: 'top-run-continue',
        childRunId: seededPayload.childRunId,
        subagentType: 'worker',
        capabilities: [],
        toolSurface: 'worker',
        approval: {
          callId: 'call-child-approval',
          runId: seededPayload.childRunId,
          threadId: seededPayload.childThreadId,
          toolName: 'write_file',
          approvalClass: 'write_file',
          permissionMode: 'basic',
          argumentsPreview: {
            path: 'draft.md',
          },
          sideEffectLevel: 'write',
        },
        runtime: {
          phase: 'approval_pending',
          observedAt: approvalBridgeObservedAt,
          partialOutputAvailable: false,
          lastTool: {
            name: 'write_file',
            callId: 'call-child-approval',
            state: 'running',
          },
        },
      },
    });
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input lets continued worker inherit current parent permission mode', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-permission-'),
  );
  const threadId = testThreadId(34);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: true,
        finalProse: 'seed child answer',
      }),
    }).startBackgroundRun,
  });

  try {
    const seeded = await testAgentSpawnTool.execute(
      {
        task: 'seed child',
        subagent_type: 'worker',
      },
      {
        kind: 'agent',
        runOwnerKind: 'root_main',
        callId: 'call-seed-permission-child',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        workingDirectory: 'workspace',
        threadId,
        runId: 'top-run-seed-permission',
        runState: createRunState({
          runId: 'top-run-seed-permission',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        runtimeServices: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        computerSessionId: 'session-seed-permission',
      },
    );

    assert.equal(seeded.ok, true);
    const seededPayload = JSON.parse(seeded.output) as {
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertValidRunId(seededPayload.childRunId);
    const childThreadId = assertValidThreadId(seededPayload.childThreadId);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    let capturedApprovalContext:
      | {
          computerSessionId: string;
          permissionMode: 'basic' | 'full_access';
          ownerRunId?: string;
          ownerThreadId?: string;
        }
      | undefined;
    const testAgentSendInputTool = createAgentSendInputTool({
      startBackgroundRun: createSubagentRunLauncher({
        runAgentLoop: async (input) => {
          capturedApprovalContext = input.approvalContext;
          return {
            ok: true,
            finalProse: 'continued child answer',
          };
        },
      }).startBackgroundRun,
    });
    await daemonContext.runCheckpoints.startRun({
      runId: assertValidRunId('top-run-continue-permission'),
      threadId,
      request: {
        workingDirectory: 'workspace',
        permissionMode: 'full_access',
      },
    });

    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: seededPayload.childRunId,
        task: 'continue child',
      },
      {
        kind: 'agent',
        runOwnerKind: 'root_main',
        callId: 'call-continue-permission',
        stateRoot,
        workingDirectory: 'workspace',
        threadId,
        runId: 'top-run-continue-permission',
        runState: createRunState({
          runId: 'top-run-continue-permission',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        computerSessionId: 'session-continue-permission',
        permissionMode: 'full_access',
        runtimeServices: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
      },
    );

    assert.equal(continued.ok, true);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });
    await waitForChildCheckpointTerminal({
      daemonContext,
      childThreadId,
    });

    assert.deepEqual(capturedApprovalContext, {
      computerSessionId: 'session-continue-permission',
      permissionMode: 'full_access',
      ownerRunId: 'top-run-continue-permission',
      ownerThreadId: threadId,
    });
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input rejects standalone worker continuation without approval routing', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-standalone-worker-'),
  );
  const threadId = testThreadId(35);
  const { daemonContext, runtimeStateStore } =
    await createDurableAgentToolTestContext(stateRoot);

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: true,
        finalProse: 'seed child answer',
      }),
    }).startBackgroundRun,
  });

  try {
    const seeded = await testAgentSpawnTool.execute(
      {
        task: 'seed child',
        subagent_type: 'worker',
      },
      {
        kind: 'agent',
        runOwnerKind: 'root_main',
        callId: 'call-seed-standalone-worker-child',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        workingDirectory: 'workspace',
        threadId,
        runId: 'top-run-seed-standalone-worker',
        runState: createRunState({
          runId: 'top-run-seed-standalone-worker',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        runtimeServices: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        computerSessionId: 'session-seed-standalone-worker',
      },
    );

    assert.equal(seeded.ok, true);
    const seededPayload = JSON.parse(seeded.output) as {
      childRunId: string;
    };
    const childRunId = assertValidRunId(seededPayload.childRunId);
    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    let startCalled = false;
    const testAgentSendInputTool = createAgentSendInputTool({
      startBackgroundRun: async () => {
        startCalled = true;
        throw new Error('startBackgroundRun should not be called');
      },
    });

    const rejected = await testAgentSendInputTool.execute(
      {
        child_run_id: seededPayload.childRunId,
        task: 'continue worker from standalone context',
      },
      {
        callId: 'call-continue-standalone-worker',
        stateRoot,
        threadId,
        runId: 'top-run-continue-standalone-worker',
        runState: createRunState({
          runId: 'top-run-continue-standalone-worker',
          runContext: makeRunContext({
            threadId,
            stateRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'session-standalone-worker',
        permissionMode: 'full_access',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorCode, 'execution_failed');
    assert.match(rejected.error, /approval event routing/);
    assert.equal(startCalled, false);
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

void test('agent_send_input continues retained terminal child handles', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-retained-terminal-'),
  );
  t.after(() =>
    rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }),
  );
  const ownerThreadId = testThreadId(36);
  const childRunId = testRunId('send-input-terminal-child');
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });

  daemonContext.childRuns.registerChildRun({
    childRunId,
    childThreadId: testThreadId(37),
    parentRunId: testRunId('send-input-terminal-parent'),
    ownerThreadId,
    subagentType: 'explorer',
    capabilities: ['ptc'],
    modelPin: {
      modelId: 'gpt-5.6-luna',
      providerRunSelection: {
        providerModel: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        },
        reasoningEffort: 'xhigh',
      },
      selectionSource: 'user_fixed',
    },
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'done',
  });

  let continuedTask: string | undefined;
  const testAgentSendInputTool = createAgentSendInputTool({
    startBackgroundRun: async (input) => {
      continuedTask = input.task;
      assert.equal(input.ultraReasoning, true);
      assert.deepEqual(input.capabilities, ['ptc']);
      assert.deepEqual(input.modelPin, {
        modelId: 'gpt-5.6-luna',
        providerRunSelection: {
          providerModel: {
            providerId: 'openai_codex_direct',
            model: 'gpt-5.6-luna',
          },
          reasoningEffort: 'xhigh',
        },
        selectionSource: 'user_fixed',
      });
      assert.deepEqual(input.subagentModelRouting, {
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      });
      return { ok: true, output: 'continued' };
    },
  });

  const parentRunId = testRunId('send-input-terminal-top');
  await daemonContext.runCheckpoints.startRun({
    runId: parentRunId,
    threadId: ownerThreadId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  const result = await testAgentSendInputTool.execute(
    {
      child_run_id: childRunId,
      task: 'continue retained child',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-send-input-terminal',
      providerRunSelection: {
        providerModel: { providerId: 'grok_oauth', model: 'grok-4.5' },
        reasoningEffort: 'high',
      },
      subagentModelRouting: { mode: 'auto' },
      stateRoot,
      workingDirectory: stateRoot,
      threadId: ownerThreadId,
      runId: parentRunId,
      runState: createRunState({
        runId: parentRunId,
        runContext: makeRunContext({
          threadId: ownerThreadId,
          stateRoot,
        }),
      }),
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'send-input-terminal-session',
      permissionMode: 'full_access',
      ultraReasoning: true,
      emitAgentEvent: () => {},
      memoryIndex: undefined,
      runtimeServices: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(continuedTask, 'continue retained child');
});

void test('agent_send_input replays one prepared child delivery after daemon replacement without duplicating the transcript input', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-restart-'),
  );
  const ownerThreadId = testThreadId(38);
  const childThreadId = testThreadId(39);
  const parentRunId = testRunId('send-input-restart-parent');
  const childRunId = testRunId('send-input-restart-child');
  const callId = 'call-send-input-restart';
  const task = 'deliver this follow-up exactly once';
  const firstContext = createDaemonContext({ homeStateRoot: stateRoot });
  const deliveryEntryId =
    'agent-send-input:call-send-input-restart:child-input';
  const deliveryTimestamp = '2026-07-29T00:00:00.000Z';
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId: ownerThreadId,
      stateRoot,
    }),
  });
  const baseToolContext = {
    kind: 'agent' as const,
    runOwnerKind: 'root_main' as const,
    callId,
    providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
    subagentModelRouting: { mode: 'auto' as const },
    stateRoot,
    workingDirectory: stateRoot,
    threadId: ownerThreadId,
    runId: parentRunId,
    runState: parentRunState,
    signal: new AbortController().signal,
    runSignal: new AbortController().signal,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: true,
    computerSessionId: 'send-input-restart-session',
    permissionMode: 'full_access' as const,
    ultraReasoning: false,
    emitAgentEvent: () => {},
    memoryIndex: undefined,
  };

  try {
    firstContext.childRuns.registerChildRun({
      childRunId,
      childThreadId,
      parentRunId: testRunId('send-input-restart-original-parent'),
      ownerThreadId,
      subagentType: 'explorer',
      capabilities: [],
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: { mode: 'auto' },
    });
    firstContext.childRuns.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: 'original child result',
    });
    await firstContext.runCheckpoints.startRun({
      runId: parentRunId,
      threadId: ownerThreadId,
      request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
    });
    const recorded = await firstContext.runCheckpoints.recordToolInvocation({
      threadId: ownerThreadId,
      runId: parentRunId,
      invocation: {
        callId,
        toolName: 'agent_send_input',
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: {
          schemaVersion: 1,
          childRunId,
          childThreadId,
          taskDigest: `sha256:${createHash('sha256').update(task).digest('hex')}`,
          childInput: {
            entryId: deliveryEntryId,
            timestamp: deliveryTimestamp,
          },
          priorChildCheckpoint: null,
        },
      },
    });
    assert.equal(recorded.ok, true);
    const { promptContext } = createAgentLoopPromptPort().buildPromptBundle({
      threadId: childThreadId,
    });
    const modelPrompt = composeAgentLoopUserPrompt({
      prompt: task,
      promptContext,
    });
    await appendTranscriptEntry(stateRoot, childThreadId, {
      entryId: deliveryEntryId,
      role: 'user',
      content: task,
      timestamp: deliveryTimestamp,
      ...(modelPrompt === task
        ? {}
        : { metadata: { hiddenPrompt: modelPrompt } }),
    });

    const replacementContext = createDaemonContext({
      homeStateRoot: stateRoot,
    });
    replacementContext.childRuns.registerChildRun({
      childRunId,
      childThreadId,
      parentRunId: testRunId('send-input-restart-original-parent'),
      ownerThreadId,
      subagentType: 'explorer',
      capabilities: [],
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: { mode: 'auto' },
    });
    replacementContext.childRuns.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: 'original child result',
    });
    let replacementExecutions = 0;
    const replacementTool = createAgentSendInputTool({
      startBackgroundRun: createSubagentRunLauncher({
        runAgentLoop: async () => {
          replacementExecutions += 1;
          return {
            ok: true,
            finalProse: 'replacement child result',
          };
        },
      }).startBackgroundRun,
    });

    const replayed = await replacementTool.execute(
      { child_run_id: childRunId, task },
      { ...baseToolContext, runtimeServices: replacementContext },
    );
    assert.equal(replayed.ok, true);
    await waitForChildStatus({
      daemonContext: replacementContext,
      childRunId,
      status: 'completed',
    });

    const matchingInputs = (
      await readTranscriptEntries(stateRoot, childThreadId)
    ).filter((entry) => entry.role === 'user' && entry.content === task);
    assert.equal(replacementExecutions, 1);
    assert.equal(matchingInputs.length, 1);
    const parentCheckpoint =
      await replacementContext.runCheckpoints.readThread(ownerThreadId);
    assert.equal(parentCheckpoint?.toolInvocations.length, 1);
    assert.equal(parentCheckpoint?.toolInvocations[0]?.status, 'reconciled');
    assert.deepEqual(parentCheckpoint?.toolInvocations[0]?.result, replayed);

    const conflictingReplay = await replacementTool.execute(
      {
        child_run_id: childRunId,
        task: 'a different follow-up must not reuse the durable delivery',
      },
      { ...baseToolContext, runtimeServices: replacementContext },
    );
    assert.equal(conflictingReplay.ok, false);
    assert.match(
      conflictingReplay.error ?? '',
      /agent_send_input recovery state conflicts/,
    );
    assert.equal(replacementExecutions, 1);
    assert.equal(
      (await readTranscriptEntries(stateRoot, childThreadId)).filter(
        (entry) =>
          entry.role === 'user' &&
          entry.content ===
            'a different follow-up must not reuse the durable delivery',
      ).length,
      0,
    );
  } finally {
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
