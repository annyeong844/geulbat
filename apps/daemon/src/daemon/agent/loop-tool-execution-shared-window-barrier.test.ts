import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  createDeferred,
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

void test('processFunctionCalls treats write tools as barriers without collapsing later read windows', async () => {
  const threadId = testThreadId(155);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-barrier-window-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-barrier-window-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const releaseFirstReads = createDeferred<void>();
  const releaseWrite = createDeferred<void>();
  const releaseSecondReads = createDeferred<void>();
  const firstReadsStarted = createDeferred<void>();
  const writeStarted = createDeferred<void>();
  const secondReadsStarted = createDeferred<void>();
  let firstReadStarts = 0;
  let secondReadStarts = 0;
  let writeHasStarted = false;

  const makeWindowReadTool = (name: string, windowName: 'first' | 'second') =>
    makeTestTool({
      name,
      description: `${windowName} read window tool`,
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        if (windowName === 'first') {
          firstReadStarts += 1;
          if (firstReadStarts === 2) {
            firstReadsStarted.resolve();
          }
          await releaseFirstReads.promise;
          return { ok: true, output: `${name} complete` };
        }

        secondReadStarts += 1;
        if (secondReadStarts === 2) {
          secondReadsStarted.resolve();
        }
        await releaseSecondReads.promise;
        return { ok: true, output: `${name} complete` };
      },
    });

  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_first_read_one', 'first'),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_first_read_two', 'first'),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'barrier_write_tool',
      description: 'write tool barrier',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        writeHasStarted = true;
        writeStarted.resolve();
        await releaseWrite.promise;
        return { ok: true, output: 'write complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_second_read_one', 'second'),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_second_read_two', 'second'),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-barrier-read-1',
        callId: 'call-barrier-read-1',
        name: 'barrier_first_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-2',
        callId: 'call-barrier-read-2',
        name: 'barrier_first_read_two',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-write',
        callId: 'call-barrier-write',
        name: 'barrier_write_tool',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-3',
        callId: 'call-barrier-read-3',
        name: 'barrier_second_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-4',
        callId: 'call-barrier-read-4',
        name: 'barrier_second_read_two',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-write-barrier-window',
      computerFileRoot,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-write-barrier-window',
      }),
      emit: () => {},
    }),
  });

  await firstReadsStarted.promise;
  assert.equal(writeHasStarted, false);
  assert.equal(secondReadStarts, 0);

  releaseFirstReads.resolve();
  await writeStarted.promise;
  assert.equal(secondReadStarts, 0);

  releaseWrite.resolve();
  await secondReadsStarted.promise;
  assert.equal(secondReadStarts, 2);

  releaseSecondReads.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 5);
});

void test('processFunctionCalls requires explicit shared-safe metadata before a call enters a shared window', async () => {
  const scenarios = [
    {
      id: 'conflicting_subagent_write',
      description: 'subagent batch marker with write side effects',
      sideEffectLevel: 'write' as const,
      requiresApproval: false,
      parallelBatchKind: 'subagent_launch' as const,
    },
    {
      id: 'conflicting_subagent_read',
      description: 'subagent batch marker with read side effects',
      sideEffectLevel: 'read' as const,
      requiresApproval: false,
      parallelBatchKind: 'subagent_launch' as const,
    },
    {
      id: 'conflicting_ptc_cell_read',
      description: 'PTC cell batch marker with read side effects',
      sideEffectLevel: 'read' as const,
      requiresApproval: false,
      parallelBatchKind: 'ptc_cell' as const,
    },
    {
      id: 'approval_flagged_read',
      description: 'read tool with approval metadata',
      sideEffectLevel: 'read' as const,
      requiresApproval: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const threadId = testThreadId(156 + index);
    const daemonContext = createDaemonContext();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), `geulbat-metadata-gate-${scenario.id}-`),
    );
    const runContext = makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    });
    const history: HistoryItem[] = [];

    registerOnce(
      daemonContext,
      makeTestTool({
        name: `${scenario.id}_first_tool`,
        description: scenario.description,
        sideEffectLevel: scenario.sideEffectLevel,
        requiresApproval: scenario.requiresApproval,
        ...(scenario.parallelBatchKind
          ? { parallelBatchKind: scenario.parallelBatchKind }
          : {}),
        async executeParsed() {
          return { ok: true, output: 'first complete' };
        },
      }),
    );
    registerOnce(
      daemonContext,
      makeTestTool({
        name: `${scenario.id}_second_read_tool`,
        description: 'explicitly shared-safe follow-up read',
        sideEffectLevel: 'read',
        requiresApproval: false,
        async executeParsed() {
          return { ok: true, output: 'second complete' };
        },
      }),
    );

    const result = await processFunctionCalls({
      functionCalls: [
        {
          id: `fc-${scenario.id}-first`,
          callId: `call-${scenario.id}-first`,
          name: `${scenario.id}_first_tool`,
          arguments: '{}',
        },
        {
          id: `fc-${scenario.id}-second`,
          callId: `call-${scenario.id}-second`,
          name: `${scenario.id}_second_read_tool`,
          arguments: '{}',
        },
      ],
      round: 0,
      history,
      runtime: makeExecutionRuntime(daemonContext, {
        runContext,
        runId: `run-${scenario.id}`,
        approvalContext: makeApprovalContext({
          computerSessionId: `session-${scenario.id}`,
          permissionMode: 'full_access',
        }),
        emit: () => {},
      }),
    });

    assert.deepEqual(result, { ok: true, value: undefined });
    assert.equal(history.length, 2);

    const transcript = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      transcript.map((entry) => entry.role),
      ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
    );
  }
});

void test('processFunctionCalls keeps write tools on the sequential path', async () => {
  const threadId = testThreadId(6);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-sequential-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-sequential-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const releaseFirstTool = createDeferred<void>();
  const firstToolStarted = createDeferred<void>();
  let firstStarted = false;
  let secondStarted = false;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'sequential_write_gate_tool',
      description: 'write tool should keep sequential order',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        firstStarted = true;
        firstToolStarted.resolve();
        await releaseFirstTool.promise;
        return { ok: true, output: 'write finished' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'sequential_followup_read_tool',
      description: 'should not start until write completes',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        secondStarted = true;
        return { ok: true, output: 'read finished' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-sequential-write-1',
        callId: 'call-sequential-write-1',
        name: 'sequential_write_gate_tool',
        arguments: '{}',
      },
      {
        id: 'fc-sequential-write-2',
        callId: 'call-sequential-write-2',
        name: 'sequential_followup_read_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-sequential-write',
      computerFileRoot,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-sequential-write',
      }),
      emit: () => {},
    }),
  });

  await firstToolStarted.promise;
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);

  releaseFirstTool.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(secondStarted, true);
  assert.equal(history.length, 2);
});
