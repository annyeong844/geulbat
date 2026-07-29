import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDetachedHandle,
  makeDetachedSegment,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { waitForExecuteCodeCell } from './execute-code-cell-wait.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from './execute-code-runtime-contract.js';

void test('waitForExecuteCodeCell preserves terminal output when terminate races natural completion', async () => {
  const threadId = testThreadId(914);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_wait_terminate_race',
  });
  const admitted = registry.reserveAdmittingCell({ threadId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }

  registry.promoteAdmittedCell({
    threadId,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'unused-active-output\n' }),
      }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint the session');
      },
    },
  });

  const terminalResult = {
    status: 'completed' as const,
    output: makeDetachedSegment({ stdout: 'IMPORTANT RESULT\n' }),
    exit: { kind: 'exit', exitCode: 0, processTerminated: true } as const,
  };
  let closeCalls = 0;
  const racingRegistry: ReturnType<typeof createPtcExecuteCodeCellRegistry> = {
    ...registry,
    closeCell: async (args) => {
      closeCalls += 1;
      const recorded = await registry.recordTerminalCellResult({
        threadId,
        cellId: admitted.cellId,
        result: terminalResult,
      });
      assert.deepEqual(recorded, { ok: true, value: { bridgeClosed: true } });
      return registry.closeCell(args);
    },
  };

  const result = await waitForExecuteCodeCell({
    cellRegistry: racingRegistry,
    runContext: { threadId },
    request: { cellId: admitted.cellId, terminate: true },
    signal: undefined,
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
      policyId: 'ptc_lab_execute_code_batch_node_v1',
      executionSurface: 'node_via_lab_detached_cell',
      status: 'completed',
      cellId: 'ptc_cell_wait_terminate_race',
      exitCode: 0,
      stdout: 'IMPORTANT RESULT\n',
      stderr: '',
    },
  });
  assert.equal(closeCalls, 1);
  assert.equal(registry.readCellState({ threadId }), null);
});

void test('waitForExecuteCodeCell checkpoints prepared running output before release and retries it after persistence failure', async () => {
  const threadId = testThreadId(914_01);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_wait_delivery_linearized',
  });
  const admitted = registry.reserveAdmittingCell({ threadId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  const order: string[] = [];
  let commitCount = 0;
  registry.promoteAdmittedCell({
    threadId,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: {
        drainNewOutput() {
          assert.fail(
            'durable wait must prepare output instead of draining it',
          );
        },
        prepareOutputDelivery() {
          order.push('prepare');
          return {
            output: {
              stdout: 'checkpoint before release\n',
              stderr: '',
            },
            offsets: {
              stdoutBytes: 26,
              stderrBytes: 0,
            },
          };
        },
        commitPreparedOutputDelivery() {
          order.push('commit');
          commitCount += 1;
        },
        getOutputRevision: () => 1,
        exit: new Promise(() => undefined),
        terminate() {},
      },
      closeBridge: () => {},
      taintSession: () => true,
    },
  });

  const failed = await waitForExecuteCodeCell({
    cellRegistry: registry,
    runContext: { threadId },
    request: { cellId: admitted.cellId },
    runningOutputDelivery: {
      persist() {
        order.push('persist-failed');
        throw new Error('simulated durable checkpoint failure');
      },
    },
    signal: undefined,
  });
  assert.equal(failed.ok, false);
  assert.equal(
    failed.ok ? '' : failed.reasonCode,
    'ptc_execute_code_cell_wait_unavailable',
  );
  assert.deepEqual(order, ['prepare', 'persist-failed']);
  assert.equal(commitCount, 0);

  const recovered = await waitForExecuteCodeCell({
    cellRegistry: registry,
    runContext: { threadId },
    request: { cellId: admitted.cellId },
    runningOutputDelivery: {
      persist(delivery) {
        order.push('persisted');
        assert.deepEqual(delivery, {
          cellId: admitted.cellId,
          stdout: 'checkpoint before release\n',
          stderr: '',
          outputReadOffsets: {
            stdoutBytes: 26,
            stderrBytes: 0,
          },
        });
      },
    },
    signal: undefined,
  });
  assert.equal(recovered.ok, true);
  assert.equal(
    recovered.ok && 'stdout' in recovered.value
      ? recovered.value.stdout
      : undefined,
    'checkpoint before release\n',
  );
  assert.deepEqual(order, [
    'prepare',
    'persist-failed',
    'prepare',
    'persisted',
    'commit',
  ]);
  assert.equal(commitCount, 1);
});
