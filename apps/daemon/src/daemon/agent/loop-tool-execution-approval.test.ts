import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext } from '../context.js';
import { readFile } from '../files/read-file.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
  startApprovalCheckpoint,
} from '../../test-support/loop-tool-execution-test-support.js';

void test('approval denial persists tool_result to transcript before terminal failure', async () => {
  const threadId = testThreadId(2);
  const runId = testRunId('denied');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-denied-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_transcript_test_tool',
      description: 'test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not run' };
      },
    }),
  );

  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const execution = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-denied',
        callId: 'call-denied',
        name: 'approval_transcript_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-denied',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              'call-denied',
              runId,
              threadId,
              'denied',
            );
          }, 0);
        }
      },
    }),
  });

  const result = await execution;
  assert.equal(result.ok, false);
  assert.deepEqual(events, [
    'tool_call',
    'approval_required',
    'tool_result',
    'error',
  ]);
  assert.equal(history.length, 1);
  const firstHistoryItem = history[0];
  assert.equal(firstHistoryItem?.kind, 'function_call_output');
  if (firstHistoryItem?.kind === 'function_call_output') {
    assert.match(firstHistoryItem.output, /approval_denied/);
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
});

void test('approval denial settles later same-round tool obligations before terminal failure', async () => {
  const threadId = testThreadId(2_1);
  const runId = testRunId('denied-later');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-denied-later-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  let laterReadExecutions = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_denial_barrier_tool',
      description: 'approval denial barrier tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not run' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'read_after_approval_denial_tool',
      description: 'read after approval denial',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        laterReadExecutions += 1;
        return { ok: true, output: 'should not run after denial' };
      },
    }),
  );

  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-denied-barrier',
        callId: 'call-denied-barrier',
        name: 'approval_denial_barrier_tool',
        arguments: '{}',
      },
      {
        id: 'fc-read-after-denial',
        callId: 'call-read-after-denial',
        name: 'read_after_approval_denial_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-denied-later',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              'call-denied-barrier',
              runId,
              threadId,
              'denied',
            );
          }, 0);
        }
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(laterReadExecutions, 0);
  assert.deepEqual(events, [
    'tool_call',
    'approval_required',
    'tool_result',
    'tool_call',
    'tool_result',
    'error',
  ]);
  assert.equal(history.length, 2);
  const laterOutput = JSON.parse(
    history[1]?.kind === 'function_call_output' ? history[1].output : '{}',
  ) as { ok?: boolean; errorCode?: string; error?: string };
  assert.equal(laterOutput.ok, false);
  assert.equal(laterOutput.errorCode, 'approval_denied');
  assert.match(laterOutput.error ?? '', /earlier call ended the run/u);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
  );
});

void test('approval-delayed write_file surfaces stale conflicts after external modification before resume', async () => {
  const threadId = testThreadId(22);
  const runId = testRunId('approval-stale');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-stale-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-stale-files-'),
  );
  const absolutePath = join(computerFileRoot, 'draft.md');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'draft.md');
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-approval-stale',
        callId: 'call-approval-stale',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'draft.md',
          content: 'updated\n',
          versionToken: file.versionToken,
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      computerFileRoot,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-approval-stale',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void (async () => {
              await writeFile(absolutePath, 'external\n', 'utf8');
              void daemonContext.approvalGate.resolveApproval(
                'call-approval-stale',
                runId,
                threadId,
                'approved',
              );
            })();
          }, 0);
        }
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'approval_required', 'tool_result']);
  assert.equal(history.length, 1);
  const firstHistoryItem = history[0];
  assert.equal(firstHistoryItem?.kind, 'function_call_output');
  if (firstHistoryItem?.kind === 'function_call_output') {
    assert.match(firstHistoryItem.output, /conflict_stale_write/);
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  const toolResultEntry = transcript[1];
  assert.equal(toolResultEntry?.role, 'tool_result');
  if (toolResultEntry?.role === 'tool_result') {
    const storedResult = JSON.parse(toolResultEntry.content) as {
      ok: boolean;
      errorCode?: string;
    };
    assert.equal(storedResult.ok, false);
    assert.equal(storedResult.errorCode, 'conflict_stale_write');
  }
});

void test('full_access auto-approved write skips prompt and executes successfully', async () => {
  const threadId = testThreadId(3);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_full_access_test_tool',
      description: 'test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'executed' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-full-access-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-full-access',
        callId: 'call-full-access',
        name: 'approval_full_access_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-full-access',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-full-access',
        permissionMode: 'full_access',
      }),
      emit: (type) => {
        events.push(type);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  assert.equal(history.length, 1);
  const historyItem = history[0];
  assert.equal(historyItem?.kind, 'function_call_output');
  if (historyItem?.kind === 'function_call_output') {
    assert.equal(historyItem.output, 'executed');
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  const toolResultEntry = transcript[1];
  assert.equal(toolResultEntry?.role, 'tool_result');
  if (toolResultEntry?.role === 'tool_result') {
    const storedResult = JSON.parse(toolResultEntry.content) as {
      ok: boolean;
      output: string;
    };
    assert.equal(storedResult.ok, true);
    assert.equal(storedResult.output, 'executed');
  }
});
