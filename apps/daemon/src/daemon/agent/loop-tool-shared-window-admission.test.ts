import assert from 'node:assert/strict';
import test from 'node:test';
import type { DaemonContext } from '../context.js';
import type { FunctionCall } from '../llm/index.js';
import { createFunctionCallRunStateFixture } from '../../test-support/loop-tool-execution-test-support.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createResourceBudgetProvider } from './resource-budget-provider.js';
import { createSubagentAdmissionController } from './subagent-concurrency.js';
import {
  admitSharedToolWindow,
  type SharedToolWindowCallKind,
} from './loop-tool-shared-window-admission.js';

function preparedCall(
  name: string,
  sharedKind: SharedToolWindowCallKind,
): {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  sharedKind: SharedToolWindowCallKind;
} {
  return {
    functionCall: {
      id: `fc-${name}`,
      callId: `call-${name}`,
      name,
      arguments: '{}',
    },
    toolArgs: {},
    sharedKind,
  };
}

void test('admitSharedToolWindow captures one resource snapshot before subagent admission', async () => {
  const fixture = await createFunctionCallRunStateFixture({
    threadId: testThreadId(159),
    runId: 'run-ptc-cell-admission',
    workspacePrefix: 'geulbat-ptc-cell-admission-',
    ultraReasoning: true,
  });
  const events: string[] = [];
  const observedUltraReasoning: Array<boolean | undefined> = [];
  let capturedSnapshotId: string | undefined;
  const resourceBudgetProvider = createResourceBudgetProvider();
  const subagentAdmission = createSubagentAdmissionController({});
  const runtimeServices: DaemonContext = {
    ...fixture.daemonContext,
    agent: {
      ...fixture.daemonContext.agent,
      resourceBudgetProvider: {
        captureSnapshot(args = {}) {
          events.push('resource-snapshot');
          assert.equal(args.runState, fixture.runState);
          const snapshot = resourceBudgetProvider.captureSnapshot(args);
          capturedSnapshotId = snapshot.snapshotId;
          return snapshot;
        },
      },
    },
    subagent: {
      ...fixture.daemonContext.subagent,
      admission: {
        reserveSubagentLaunchSlots(args) {
          events.push('subagent-admission');
          observedUltraReasoning.push(args.ultraReasoning);
          return subagentAdmission.reserveSubagentLaunchSlots(args);
        },
      },
    },
  };

  const admission = admitSharedToolWindow({
    preparedFunctionCalls: [
      preparedCall('ptc_admission_read', 'read_only'),
      preparedCall('ptc_admission_subagent', 'subagent_launch'),
      preparedCall('ptc_admission_cell_one', 'ptc_cell'),
      preparedCall('ptc_admission_cell_two', 'ptc_cell'),
    ],
    runtime: fixture.makeRuntime(runtimeServices),
  });

  try {
    assert.deepEqual(events, ['resource-snapshot', 'subagent-admission']);
    assert.deepEqual(observedUltraReasoning, [true]);
    assert.equal(typeof admission.resourceSnapshotRef?.snapshotId, 'string');
    assert.equal(admission.resourceSnapshotRef?.snapshotId, capturedSnapshotId);
  } finally {
    admission.release();
  }
});
