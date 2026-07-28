import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { trackAdoptedRunningCellCompletion } from './execute-code-cell-settlement.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
} from './execute-code-cell-process.js';
import type { PtcExecuteCodeCellId } from './execute-code-runtime-contract.js';

const THREAD_ID = 'thread-cell-settlement';

void test('adopted cell completion does not close a cell that another owner already removed', async () => {
  const registry = createPtcExecuteCodeCellRegistry();
  let closeCount = 0;
  const observedRegistry: ReturnType<typeof createPtcExecuteCodeCellRegistry> =
    {
      ...registry,
      readCellState: () => null,
      closeCell: async () => {
        closeCount += 1;
        return { ok: false, reasonCode: 'cell_missing' };
      },
    };

  await new Promise<void>((resolve) => {
    trackAdoptedRunningCellCompletion({
      cellRegistry: observedRegistry,
      cellId: 'ptc_cell_already_removed',
      handle: makeHandle({
        exit: { kind: 'signal', exitCode: null, processTerminated: false },
      }),
      threadId: THREAD_ID,
      onSettled: resolve,
    });
  });

  assert.equal(closeCount, 0);
});

void test('adopted cell completion preserves cleanup failures after terminal recording is rejected', async (t) => {
  const cases: Array<{
    name: string;
    exit: DetachedProcessExitInfo;
    expectedMessage: string;
    expectedDiagnostics: Record<string, string | number | boolean>;
  }> = [
    {
      name: 'output limit',
      exit: {
        kind: 'output_limit_exceeded',
        exitCode: null,
        processTerminated: false,
        stream: 'stderr',
        maxBufferedBytesPerStream: 4096,
      },
      expectedMessage: 'PTC execute_code cell cleanup failed',
      expectedDiagnostics: {
        cellExitKind: 'output_limit_exceeded',
        cellCloseStatus: 'terminated',
        sessionCloseFailed: true,
        sessionTainted: true,
      },
    },
    {
      name: 'terminal signal',
      exit: { kind: 'signal', exitCode: null, processTerminated: false },
      expectedMessage:
        'PTC execute_code cell cleanup failed after terminal signal',
      expectedDiagnostics: {
        cellExitKind: 'signal',
        cellCloseStatus: 'terminated',
        sessionCloseFailed: true,
        sessionTainted: true,
      },
    },
    {
      name: 'normal exit',
      exit: { kind: 'exit', exitCode: 0, processTerminated: true },
      expectedMessage: 'PTC execute_code cell cleanup failed',
      expectedDiagnostics: {
        cellCloseStatus: 'terminated',
        sessionCloseFailed: true,
        sessionTainted: true,
      },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const cellId =
        `ptc_cell_record_rejected_${index + 1}` as PtcExecuteCodeCellId;
      const handle = makeHandle({ exit: scenario.exit });
      const registry = createPtcExecuteCodeCellRegistry({
        createCellId: () => cellId,
      });
      const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
      assert.deepEqual(admitted, { ok: true, cellId });
      if (!admitted.ok) {
        return;
      }
      assert.deepEqual(
        registry.promoteAdmittedCell({
          threadId: THREAD_ID,
          cellId,
          resources: {
            effectiveTimeoutMs: 60_000,
            handle,
            closeBridge: () => {},
            taintSession: () => false,
          },
        }),
        { ok: true, value: { state: 'running' } },
      );

      const recordingFailureRegistry: ReturnType<
        typeof createPtcExecuteCodeCellRegistry
      > = {
        ...registry,
        recordTerminalCellResult: async () => ({
          ok: false,
          reasonCode: 'cell_missing',
        }),
      };
      await new Promise<void>((resolve) => {
        trackAdoptedRunningCellCompletion({
          cellRegistry: recordingFailureRegistry,
          cellId,
          handle,
          threadId: THREAD_ID,
          onSettled: resolve,
        });
      });

      assert.deepEqual(
        registry.takeTerminalCellResult({ threadId: THREAD_ID, cellId }),
        {
          ok: true,
          value: {
            status: 'cleanup_failed',
            message: scenario.expectedMessage,
            diagnostics: scenario.expectedDiagnostics,
          },
        },
      );
    });
  }
});

function makeHandle(args: {
  exit: DetachedProcessExitInfo;
}): DetachedProcessHandle {
  return {
    drainNewOutput: () => ({ stdout: 'partial output\n', stderr: '' }),
    exit: Promise.resolve(args.exit),
    terminate: () => {},
  };
}
