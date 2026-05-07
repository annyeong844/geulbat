import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentSpawnTool } from './agent-spawn.js';
import { agentStopTool } from './agent-stop.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../../test-support/run-workspace-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';

async function waitForChildTerminal(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  childRunId: RunId;
}): Promise<{
  status: string;
  reason: string | null | undefined;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = args.daemonContext.childRuns.getChildRun(args.childRunId);
    if (
      snapshot &&
      (snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled')
    ) {
      return {
        status: snapshot.status,
        reason: snapshot.reason,
      };
    }
    await delay(10);
  }
  throw new Error(`child ${args.childRunId} did not become terminal`);
}

void test('agent_stop cancels a running child with explicit_stop reason', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-stop-'));
  const threadId = testThreadId(41);
  const projectId = testProjectId();
  const daemonContext = createDaemonContext();

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async ({ signal }) => {
        if (!signal) {
          throw new Error('expected child run signal');
        }
        if (signal.aborted) {
          throw new Error('child aborted');
        }
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('child aborted')),
            { once: true },
          );
        });
      },
    }).startBackgroundRun,
  });

  try {
    const parentState = createRunState({
      runId: 'top-run-stop',
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId,
        workspaceRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'long running child',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn-stop',
        workspaceRoot,
        threadId,
        runId: 'top-run-stop',
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
    const childRunId = assertRunId(spawnPayload.childRunId);

    const stopped = await agentStopTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
      },
      {
        callId: 'call-stop-child',
        workspaceRoot,
        threadId,
        runId: 'top-run-stop-2',
        agentSpawnRuntime: daemonContext,
      },
    );

    assert.equal(stopped.ok, true);
    const stopPayload = JSON.parse(stopped.output) as {
      childRunId: string;
      stopState: string;
    };
    assert.equal(stopPayload.childRunId, spawnPayload.childRunId);
    assert.equal(stopPayload.stopState, 'stopping');

    const terminal = await waitForChildTerminal({
      daemonContext,
      childRunId,
    });
    assert.equal(terminal.status, 'cancelled');
    assert.equal(terminal.reason, 'explicit_stop');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('agent_stop returns already_terminal for a completed child', async () => {
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(43);
  const childRunId = testRunId('child-terminal');
  daemonContext.childRuns.registerChildRun({
    childRunId,
    childThreadId: testThreadId(47),
    parentRunId: testRunId('parent-run'),
    ownerThreadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'done',
  });

  const stopped = await agentStopTool.execute(
    {
      child_run_id: childRunId,
    },
    {
      callId: 'call-stop-terminal',
      workspaceRoot: '/tmp/workspace',
      threadId: ownerThreadId,
      runId: 'parent-run-2',
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(stopped.ok, true);
  const payload = JSON.parse(stopped.output) as {
    childRunId: string;
    stopState: string;
  };
  assert.equal(payload.childRunId, childRunId);
  assert.equal(payload.stopState, 'already_terminal');
});

void test('agent_stop rejects unknown child handles as an outer tool failure', async () => {
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(44);

  const stopped = await agentStopTool.execute(
    {
      child_run_id: 'missing-child',
    },
    {
      callId: 'call-stop-missing',
      workspaceRoot: '/tmp/workspace',
      threadId: ownerThreadId,
      runId: 'parent-run',
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(stopped.ok, false);
  assert.equal(stopped.errorCode, 'invalid_args');
  assert.match(stopped.error ?? '', /unknown child run/);
  assert.equal(stopped.output, '');
});

void test('agent_stop rejects child handles owned by another thread as an outer tool failure', async () => {
  const daemonContext = createDaemonContext();
  const childRunId = testRunId('foreign-child');
  daemonContext.childRuns.registerChildRun({
    childRunId,
    childThreadId: testThreadId(47),
    parentRunId: testRunId('foreign-parent'),
    ownerThreadId: testThreadId(45),
    subagentType: 'worker',
  });

  const stopped = await agentStopTool.execute(
    {
      child_run_id: childRunId,
    },
    {
      callId: 'call-stop-foreign',
      workspaceRoot: '/tmp/workspace',
      threadId: testThreadId(46),
      runId: 'parent-run',
      agentSpawnRuntime: daemonContext,
    },
  );

  assert.equal(stopped.ok, false);
  assert.equal(stopped.errorCode, 'invalid_args');
  assert.match(stopped.error ?? '', /does not belong to current owner thread/);
  assert.equal(stopped.output, '');
});
