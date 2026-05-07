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
