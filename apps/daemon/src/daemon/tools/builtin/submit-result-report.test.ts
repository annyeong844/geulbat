import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRunId } from '@geulbat/protocol/ids';

import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { submitResultReportTool } from './submit-result-report.js';

void test('submit_result_report records a child summary without replacing final prose', async () => {
  assert.equal(submitResultReportTool.recoveryStrategy, 'replay_safe');
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-submit-result-report-'),
  );
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const threadId = testThreadId(1_411);
  const runState = createRunState({
    runId: assertRunId('run-submit-result-report'),
    parentRunId: assertRunId('run-submit-result-report-parent'),
    runContext: {
      threadId,
      stateRoot: '/state',
      workingDirectory: '/workspace',
    },
  });
  const workingDirectory = runState.workingDirectory;
  assert.ok(workingDirectory);
  const baseContext = {
    kind: 'agent' as const,
    callId: 'call-submit-result-report',
    runId: runState.runId,
    stateRoot: runState.stateRoot,
    workingDirectory,
    threadId,
    runState,
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: false,
    runtimeServices: createDaemonContext({
      subagentTerminalDeliveries: store,
    }),
    memoryIndex: undefined,
    emitAgentEvent() {},
    permissionMode: 'basic' as const,
    computerSessionId: 'session-submit-result-report',
  };

  try {
    const unavailable = await submitResultReportTool.execute(
      { summary: 'must not survive without a durable source address' },
      {
        ...baseContext,
        runOwnerKind: 'child',
        runtimeServices: createDaemonContext(),
      },
    );
    assert.equal(unavailable.ok, false);
    assert.equal(runState.subagentResultReportSummary, undefined);

    const result = await submitResultReportTool.execute(
      { summary: '  핵심 결과와 근거를 정리했습니다.  ' },
      { ...baseContext, runOwnerKind: 'child' },
    );

    assert.equal(result.ok, true);
    assert.equal(
      runState.subagentResultReportSummary,
      '핵심 결과와 근거를 정리했습니다.',
    );

    const rejected = await submitResultReportTool.execute(
      { summary: 'root must not submit this report' },
      { ...baseContext, runOwnerKind: 'root_main' },
    );
    assert.equal(rejected.ok, false);
    assert.equal(
      runState.subagentResultReportSummary,
      '핵심 결과와 근거를 정리했습니다.',
    );
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
