import assert from 'node:assert/strict';
import test from 'node:test';

import { admitPtcExecutionProfile } from '../../lab/profile/lab-profile.js';
import type { PtcSessionEpochBridge } from '../../callback/session-epoch-bridge.js';
import {
  cellCleanupFailure,
  cellCloseDiagnostics,
  isProvenTerminatedCellCleanup,
  sanitizeDetachedOutputSegment,
  sensitiveBridgeMarkers,
  summarizeQueuedCell,
  summarizeRunningCell,
  summarizeWaitClosedCell,
  summarizeWaitDurableCell,
  summarizeWaitExpiredCell,
  summarizeWaitMissingCell,
  summarizeWaitQueuedCell,
  summarizeWaitRetainedCell,
  summarizeWaitRunningCell,
  validateCellId,
} from './execute-code-cell-summary.js';
import type { PtcExecuteCodeCellRetainedResult } from './execute-code-cell-terminal-retention.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

const CELL_ID = 'ptc_cell_summary_contract';

void test('cell summaries keep queued, running, missing, expired, and durable recovery states distinct', () => {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);
  if (!admission.ok) {
    throw new Error('expected lab admission');
  }
  const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
    callbacksEnabled: false,
    sdkHelp: undefined,
  });
  const callbackRuntime = {
    enabled: false,
    toolCallbacksEnabled: false,
    observedCount: () => 2,
  };

  const queued = summarizeQueuedCell({
    admission: admission.value,
    callbackRuntime,
    cellId: CELL_ID,
    effectiveTimeoutMs: 30_000,
    sdkHelpBundle,
  });
  assert.equal(
    queued.executionSurface === 'node_via_lab_detached_cell'
      ? queued.status
      : undefined,
    'queued',
  );

  const running = summarizeRunningCell({
    admission: admission.value,
    callbackRuntime,
    cellId: CELL_ID,
    durationMs: 250,
    effectiveTimeoutMs: 30_000,
    output: {
      stdout: 'secret=private-value\n',
      stderr: '/tmp/ptc-output.txt\n',
    },
    sdkHelpBundle,
  });
  assert.equal(
    running.executionSurface === 'node_via_lab_detached_cell'
      ? running.stdout
      : undefined,
    '[redacted:secret]\n',
  );
  assert.equal(
    running.executionSurface === 'node_via_lab_detached_cell'
      ? running.stderr
      : undefined,
    '[redacted:path]\n',
  );

  assert.equal(summarizeWaitQueuedCell(CELL_ID).status, 'queued');
  const waitRunning = summarizeWaitRunningCell({
    cellId: CELL_ID,
    output: { stdout: 'token=hidden', stderr: '' },
  });
  assert.equal(
    waitRunning.status === 'running' ? waitRunning.stdout : undefined,
    '[redacted:secret]',
  );
  assert.equal(summarizeWaitMissingCell(CELL_ID).status, 'missing');
  assert.equal(summarizeWaitExpiredCell(CELL_ID).status, 'expired');

  const durable = summarizeWaitDurableCell({
    cellId: CELL_ID,
    durableOutput: {
      outputRef: 'artifact://cell-output',
      fullOutputBytes: 42,
      fullOutputChars: 41,
      status: 'completed',
      exitCode: 0,
    },
  });
  assert.equal('offloaded' in durable ? durable.offloaded : undefined, true);
  assert.match('summary' in durable ? durable.summary : '', /exit code 0/u);
  const terminatedDurable = summarizeWaitDurableCell({
    cellId: CELL_ID,
    durableOutput: {
      outputRef: 'artifact://terminated-output',
      fullOutputBytes: 1,
      fullOutputChars: 1,
      status: 'terminated',
      exitCode: null,
    },
  });
  assert.doesNotMatch(
    'summary' in terminatedDurable ? terminatedDurable.summary : '',
    /exit code/u,
  );
});

void test('retained terminal summaries preserve product failures and cleanup evidence', async (t) => {
  await t.test('start failures retain all optional recovery fields', () => {
    const result = summarizeWaitRetainedCell({
      cellId: CELL_ID,
      result: {
        status: 'start_failed',
        failure: {
          ok: false,
          reasonCode: 'ptc_execute_code_store_unavailable',
          message: 'cell store is unavailable',
          remediation: 'retry after repairing the store',
          diagnostics: { storeOffline: true },
          store: { discardedWrites: 2 },
          storeError: {
            errorCode: 'StorePersistenceUnavailable',
            message: 'store persistence is unavailable',
            remediation: 'repair persistence',
          },
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.remediation, 'retry after repairing the store');
      assert.deepEqual(result.diagnostics, { storeOffline: true });
      assert.deepEqual(result.store, { discardedWrites: 2 });
      assert.equal(result.storeError?.errorCode, 'StorePersistenceUnavailable');
    }
  });

  await t.test('timeout and output rejection carry cleanup evidence', () => {
    const timedOut: PtcExecuteCodeCellRetainedResult = {
      status: 'cleanup_failed',
      message: 'container cleanup failed',
      diagnostics: { sessionCloseFailed: true },
      terminalResult: {
        status: 'terminated',
        output: { stdout: '', stderr: '' },
        exit: {
          kind: 'timeout',
          exitCode: null,
          processTerminated: false,
        },
        store: { discardedWrites: 1 },
      },
    };
    const timeout = summarizeWaitRetainedCell({
      cellId: CELL_ID,
      result: timedOut,
    });
    assert.equal(timeout.ok, false);
    if (!timeout.ok) {
      assert.equal(timeout.reasonCode, 'ptc_lab_command_timeout');
      assert.deepEqual(timeout.store, { discardedWrites: 1 });
      assert.deepEqual(timeout.diagnostics, {
        cellExitKind: 'timeout',
        cleanupFailureMessage: 'container cleanup failed',
        sessionCloseFailed: true,
      });
    }

    const rejected = summarizeWaitRetainedCell({
      cellId: CELL_ID,
      result: {
        status: 'completed',
        output: { stdout: '', stderr: '' },
        exit: {
          kind: 'output_limit_exceeded',
          exitCode: null,
          processTerminated: false,
          stream: 'stderr',
          maxBufferedBytesPerStream: 4_096,
        },
      },
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reasonCode, 'ptc_lab_command_output_rejected');
      assert.deepEqual(rejected.diagnostics, {
        outputStream: 'stderr',
        maxBufferedBytesPerStream: 4_096,
      });
    }
  });

  await t.test('store conflicts remain distinct from store failures', () => {
    const terminal = (errorCode: 'StoreCommitConflict' | 'StoreDisabled') =>
      ({
        status: 'completed',
        output: { stdout: 'done\n', stderr: '' },
        exit: { kind: 'exit', exitCode: 0, processTerminated: true },
        store: { discardedWrites: 1 },
        storeError: {
          errorCode,
          message: `commit failed: ${errorCode}`,
          remediation: 'retry in a new cell',
        },
      }) satisfies PtcExecuteCodeCellRetainedResult;

    const conflict = summarizeWaitRetainedCell({
      cellId: CELL_ID,
      result: terminal('StoreCommitConflict'),
    });
    const failed = summarizeWaitRetainedCell({
      cellId: CELL_ID,
      result: terminal('StoreDisabled'),
    });
    assert.equal(
      conflict.ok ? undefined : conflict.reasonCode,
      'ptc_execute_code_store_commit_conflict',
    );
    assert.equal(
      failed.ok ? undefined : failed.reasonCode,
      'ptc_execute_code_store_commit_failed',
    );
  });

  await t.test(
    'completed output can survive an independent cleanup failure',
    () => {
      const result = summarizeWaitRetainedCell({
        cellId: CELL_ID,
        result: {
          status: 'cleanup_failed',
          message: 'callback bridge close failed',
          diagnostics: { callbackBridgeCloseFailed: true },
          terminalResult: {
            status: 'completed',
            output: { stdout: 'done\n', stderr: '' },
            exit: { kind: 'exit', exitCode: 0, processTerminated: true },
          },
        },
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.status, 'completed_with_cleanup_failure');
        assert.deepEqual(
          'cleanupFailure' in result.value
            ? result.value.cleanupFailure
            : undefined,
          {
            message: 'callback bridge close failed',
            diagnostics: { callbackBridgeCloseFailed: true },
          },
        );
      }

      assert.deepEqual(
        summarizeWaitRetainedCell({
          cellId: CELL_ID,
          result: {
            status: 'cleanup_failed',
            message: 'cleanup owner disappeared',
            diagnostics: { ownerMissing: true },
          },
        }),
        cellCleanupFailure({
          message: 'cleanup owner disappeared',
          diagnostics: { ownerMissing: true },
        }),
      );
    },
  );
});

void test('closed-cell diagnostics distinguish missing, queued, and proven termination cleanup', () => {
  assert.deepEqual(
    summarizeWaitClosedCell({
      cellId: CELL_ID,
      output: undefined,
      exit: undefined,
    }),
    {
      ok: true,
      capabilityId: 'exec',
      policyId: 'ptc_lab_execute_code_batch_node_v1',
      executionSurface: 'node_via_lab_detached_cell',
      cellId: CELL_ID,
      exitCode: null,
      stdout: '',
      stderr: '',
      status: 'terminated',
    },
  );
  assert.deepEqual(
    cellCloseDiagnostics({ ok: false, reasonCode: 'cell_missing' }),
    { cellCloseMissing: true },
  );
  assert.deepEqual(
    cellCloseDiagnostics({ ok: true, status: 'admission_released' }),
    { cellCloseStatus: 'admission_released' },
  );
  const incomplete = {
    ok: true,
    status: 'terminated',
    output: { stdout: '', stderr: '' },
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
    bridgeClosed: false,
    sessionTainted: false,
    cleanupDiagnostics: { processExitUnproven: true },
  } as const;
  assert.equal(isProvenTerminatedCellCleanup(incomplete), false);
  assert.deepEqual(cellCloseDiagnostics(incomplete), {
    cellCloseStatus: 'terminated',
    callbackBridgeCloseFailed: true,
    sessionCloseFailed: true,
    sessionTainted: true,
    processExitUnproven: true,
  });
  assert.equal(
    isProvenTerminatedCellCleanup({
      ok: true,
      status: 'terminated',
      output: { stdout: '', stderr: '' },
      exit: { kind: 'exit', exitCode: 0, processTerminated: true },
      bridgeClosed: true,
      sessionTainted: true,
    }),
    true,
  );
});

void test('summary boundary helpers redact private output and validate durable identifiers', () => {
  assert.deepEqual(
    sanitizeDetachedOutputSegment({
      stdout: '/geulbat/callbacks/epoch.sock',
      stderr: 'authorization=Bearer secret-token',
    }),
    {
      stdout: '[redacted:callback-path]',
      stderr: '[redacted:secret]',
    },
  );
  assert.deepEqual(sensitiveBridgeMarkers(undefined), []);
  assert.deepEqual(
    sensitiveBridgeMarkers({
      token: 'bridge-token',
      callbackSocketContainerPath: '/geulbat/callbacks/callback.sock',
      callbackSocketHostPath: '/tmp/callback.sock',
    } as PtcSessionEpochBridge),
    ['bridge-token', '/geulbat/callbacks/callback.sock', '/tmp/callback.sock'],
  );
  assert.equal(validateCellId(CELL_ID), CELL_ID);
  assert.equal(validateCellId('ptc_cell_unsafe slash'), undefined);
  assert.equal(validateCellId('not-a-cell'), undefined);
});
