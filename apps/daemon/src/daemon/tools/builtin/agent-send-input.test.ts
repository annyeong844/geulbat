import test from 'node:test';
import assert from 'node:assert/strict';
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
import { readTranscriptEntries } from '../../sessions/transcript-log.js';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
  type RunId,
} from '@geulbat/protocol/ids';
import { testProjectId } from '../../../test-support/project-id.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../../test-support/run-workspace-context.js';
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

void test('agent_send_input rejects malformed handles and blank tasks at the parser boundary', async () => {
  const malformedHandle = await agentSendInputTool.execute(
    {
      child_run_id: 'run with spaces',
      task: 'follow-up',
    },
    {
      callId: 'call-send-input-malformed-handle',
      workspaceRoot: '/tmp/workspace',
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
      workspaceRoot: '/tmp/workspace',
    },
  );

  assert.equal(blankTask.ok, false);
  assert.equal(blankTask.errorCode, 'invalid_args');
  assert.match(blankTask.error ?? '', /task.*required/);
});

void test('agent_send_input continues the same child thread across top-level runs', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-'),
  );
  const threadId = testThreadId(31);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
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
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId,
        workspaceRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'first task',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn',
        workspaceRoot,
        threadId,
        runId: 'top-run-parent-1',
        projectId,
        runState: firstParentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
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
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId,
        workspaceRoot,
      }),
    });
    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
        task: 'second task',
      },
      {
        callId: 'call-continue',
        workspaceRoot,
        threadId,
        runId: 'top-run-parent-2',
        projectId,
        runState: secondParentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(continued.ok, true);
    const continuePayload = JSON.parse(continued.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
      launchState: string;
    };
    assert.deepEqual(continuePayload, {
      ok: true,
      childRunId: spawnPayload.childRunId,
      childThreadId: spawnPayload.childThreadId,
      subagentType: 'explorer',
      launchState: 'started',
    });

    await waitForChildStatus({
      daemonContext,
      childRunId,
      status: 'completed',
    });

    const transcript = await readTranscriptEntries(
      workspaceRoot,
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
        workspaceRoot,
        runId: 'top-run-parent-2',
        threadId,
        agentSpawnRuntime: daemonContext,
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input allows child runs to continue nested child handles', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-nested-'),
  );
  const childThreadId = testThreadId(35);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
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
      runContext: makeRunWorkspaceContext({
        threadId: childThreadId,
        projectId,
        workspaceRoot,
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
        workspaceRoot,
        threadId: childThreadId,
        runId: 'child-parent-run',
        projectId,
        runState: childRunState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
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
        workspaceRoot,
        threadId: childThreadId,
        runId: 'child-parent-run-2',
        projectId,
        runState: createRunState({
          runId: 'child-parent-run-2',
          runContext: makeRunWorkspaceContext({
            threadId: childThreadId,
            projectId,
            workspaceRoot,
          }),
          parentRunId: 'top-run-parent',
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(continued.ok, true);
    const continuePayload = JSON.parse(continued.output) as {
      ok: boolean;
      childRunId: string;
      childThreadId: string;
      launchState: string;
    };
    assert.deepEqual(continuePayload, {
      ok: true,
      childRunId: spawnPayload.childRunId,
      childThreadId: spawnPayload.childThreadId,
      subagentType: 'explorer',
      launchState: 'started',
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input rejects a child handle that is still running', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-busy-'),
  );
  const threadId = testThreadId(32);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();
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
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId,
        workspaceRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'busy task',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn-busy',
        workspaceRoot,
        threadId,
        runId: 'top-run-parent-busy',
        projectId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
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
        workspaceRoot,
        threadId,
        runId: 'top-run-parent-busy-2',
        projectId,
        runState: createRunState({
          runId: 'top-run-parent-busy-2',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        agentSpawnRuntime: daemonContext,
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input forwards child approval events through the shared child runner path', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-approval-'),
  );
  const threadId = testThreadId(33);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();

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
        callId: 'call-seed-child',
        workspaceRoot,
        threadId,
        runId: 'top-run-seed',
        projectId,
        runState: createRunState({
          runId: 'top-run-seed',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        agentSpawnRuntime: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        approvalSessionId: 'session-seed',
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

    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: seededPayload.childRunId,
        task: 'continue child',
      },
      {
        kind: 'agent',
        callId: 'call-continue-approval',
        workspaceRoot,
        threadId,
        runId: 'top-run-continue',
        projectId,
        runState: createRunState({
          runId: 'top-run-continue',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        approvalSessionId: 'session-continue',
        permissionMode: 'basic',
        agentSpawnRuntime: daemonContext,
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

    assert.deepEqual(emittedTypes.slice(0, 3), [
      'subagent_spawned',
      'subagent_approval_required',
      'approval_required',
    ]);
    assert.deepEqual(emittedPayloads[1], {
      type: 'subagent_approval_required',
      payload: {
        parentRunId: 'top-run-continue',
        childRunId: seededPayload.childRunId,
        subagentType: 'worker',
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
      },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input lets continued worker inherit current parent permission mode', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-permission-'),
  );
  const threadId = testThreadId(34);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();

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
        callId: 'call-seed-permission-child',
        workspaceRoot,
        threadId,
        runId: 'top-run-seed-permission',
        projectId,
        runState: createRunState({
          runId: 'top-run-seed-permission',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        agentSpawnRuntime: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        approvalSessionId: 'session-seed-permission',
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

    let capturedApprovalContext:
      | {
          sessionId: string;
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

    const continued = await testAgentSendInputTool.execute(
      {
        child_run_id: seededPayload.childRunId,
        task: 'continue child',
      },
      {
        kind: 'agent',
        callId: 'call-continue-permission',
        workspaceRoot,
        threadId,
        runId: 'top-run-continue-permission',
        projectId,
        runState: createRunState({
          runId: 'top-run-continue-permission',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        approvalSessionId: 'session-continue-permission',
        permissionMode: 'full_access',
        agentSpawnRuntime: daemonContext,
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

    assert.deepEqual(capturedApprovalContext, {
      sessionId: 'session-continue-permission',
      permissionMode: 'full_access',
      ownerRunId: 'top-run-continue-permission',
      ownerThreadId: threadId,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input rejects standalone worker continuation without approval routing', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-send-input-standalone-worker-'),
  );
  const threadId = testThreadId(35);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();

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
        callId: 'call-seed-standalone-worker-child',
        workspaceRoot,
        threadId,
        runId: 'top-run-seed-standalone-worker',
        projectId,
        runState: createRunState({
          runId: 'top-run-seed-standalone-worker',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        currentFile: undefined,
        selection: undefined,
        approvalGranted: false,
        agentSpawnRuntime: daemonContext,
        memoryIndex: undefined,
        emitAgentEvent: () => {},
        permissionMode: 'basic',
        approvalSessionId: 'session-seed-standalone-worker',
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
        workspaceRoot,
        threadId,
        runId: 'top-run-continue-standalone-worker',
        projectId,
        runState: createRunState({
          runId: 'top-run-continue-standalone-worker',
          runContext: makeRunWorkspaceContext({
            threadId,
            projectId,
            workspaceRoot,
          }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        approvalSessionId: 'session-standalone-worker',
        permissionMode: 'full_access',
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorCode, 'execution_failed');
    assert.match(rejected.error, /approval event routing/);
    assert.equal(startCalled, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_send_input continues retained terminal child handles', async () => {
  const ownerThreadId = testThreadId(36);
  const projectId = testProjectId();
  const childRunId = testRunId('send-input-terminal-child');
  const daemonContext = createDaemonContext();

  daemonContext.childRuns.registerChildRun({
    childRunId,
    childThreadId: testThreadId(37),
    parentRunId: testRunId('send-input-terminal-parent'),
    ownerThreadId,
    subagentType: 'explorer',
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
      return { ok: true, output: 'continued' };
    },
  });

  const parentRunId = testRunId('send-input-terminal-top');
  const result = await testAgentSendInputTool.execute(
    {
      child_run_id: childRunId,
      task: 'continue retained child',
    },
    {
      callId: 'call-send-input-terminal',
      workspaceRoot: '/tmp/workspace',
      threadId: ownerThreadId,
      runId: parentRunId,
      projectId,
      runState: createRunState({
        runId: parentRunId,
        runContext: makeRunWorkspaceContext({
          threadId: ownerThreadId,
          projectId,
          workspaceRoot: '/tmp/workspace',
        }),
      }),
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(continuedTask, 'continue retained child');
});
