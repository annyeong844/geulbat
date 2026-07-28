import assert from 'node:assert/strict';
import test from 'node:test';

import { admitPtcExecutionProfile } from '../../lab/profile/lab-profile.js';
import type { PtcExecuteCodeCallbackRuntime } from './execute-code-batch-runtime.js';
import { createPtcExecuteCodeCellReadoptionLedger } from './execute-code-cell-readoption.js';
import { reconcilePtcExecuteCodeInvocation } from './execute-code-invocation-reconciliation.js';
import type {
  PtcExecuteCodeCellCoordinateStore,
  PtcExecuteCodeCellTerminalResultStore,
  PtcExecuteCodeRunningExecDelivery,
  PtcExecuteCodeRuntimeResult,
} from './execute-code-runtime-contract.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

const THREAD_ID = 'thread-ptc-invocation-reconciliation';
const CELL_ID = 'ptc_cell_invocation_reconciliation';
const INVOCATION = {
  runId: 'run-reconciliation',
  callId: 'call-reconciliation',
};

void test('invocation reconciliation fails closed when durable running delivery is unavailable or unreadable', async (t) => {
  await t.test('the delivery store is unavailable', async () => {
    const result = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(),
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable running-result recovery is unavailable',
    });
  });

  await t.test('the delivery store throws while reading', async () => {
    const result = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(() => {
          throw new Error('delivery store offline');
        }),
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable running result could not be reconciled',
    });
  });

  await t.test(
    'the retained delivery belongs to another invocation',
    async () => {
      const result = await reconcilePtcExecuteCodeInvocation(
        makeReconciliationArgs({
          cellReadoptionLedger: createReadoptionLedger(() =>
            runningDelivery({ callId: 'call-from-another-invocation' }),
          ),
        }),
      );

      assert.deepEqual(result, {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message: 'PTC execute_code durable running result identity conflicts',
      });
    },
  );
});

void test('invocation reconciliation replays the exact retained running delivery', async () => {
  const result = await reconcilePtcExecuteCodeInvocation(
    makeReconciliationArgs({
      cellReadoptionLedger: createReadoptionLedger(() =>
        runningDelivery({
          stdout: 'continued stdout\n',
          stderr: 'continued stderr\n',
          durationMs: 1_234,
          toolCallbackCount: 3,
        }),
      ),
    }),
  );

  assert.equal(result?.ok, true);
  if (
    result?.ok &&
    result.value.executionSurface === 'node_via_lab_detached_cell' &&
    result.value.status === 'running'
  ) {
    assert.equal(result.value.status, 'running');
    assert.equal(result.value.cellId, CELL_ID);
    assert.equal(result.value.stdout, 'continued stdout\n');
    assert.equal(result.value.stderr, 'continued stderr\n');
    assert.equal(result.value.durationMs, 1_234);
    assert.deepEqual(result.value.toolCallbacks, {
      enabled: false,
      observed: 3,
    });
  }
});

void test('invocation reconciliation uses durable terminal recovery before consulting terminal output', async (t) => {
  const recovered: PtcExecuteCodeRuntimeResult = {
    ok: false,
    reasonCode: 'ptc_execute_code_store_unavailable',
    message: 'recovered terminal failure',
  };
  let terminalReadCount = 0;
  const recoveredResult = await reconcilePtcExecuteCodeInvocation(
    makeReconciliationArgs({
      cellReadoptionLedger: createReadoptionLedger(() => undefined),
      terminalResultStore: terminalStore({
        read: async () => {
          terminalReadCount += 1;
          return { ok: true, value: undefined };
        },
        readRecovery: async () => ({ ok: true, value: recovered }),
      }),
    }),
  );
  assert.deepEqual(recoveredResult, recovered);
  assert.equal(terminalReadCount, 0);

  await t.test('a recovery read failure remains fail-closed', async () => {
    const result = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(() => undefined),
        terminalResultStore: terminalStore({
          read: async () => ({ ok: true, value: undefined }),
          readRecovery: async () => ({
            ok: false,
            message: 'recovery artifact is corrupt',
          }),
        }),
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'recovery artifact is corrupt',
    });
  });

  await t.test('a thrown recovery read remains fail-closed', async () => {
    const result = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(() => undefined),
        terminalResultStore: terminalStore({
          read: async () => ({ ok: true, value: undefined }),
          readRecovery: async () => {
            throw new Error('recovery storage offline');
          },
        }),
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable terminal recovery could not be reconciled',
    });
  });
});

void test('invocation reconciliation refuses to duplicate a completed durable cell', async (t) => {
  const completed = {
    outputRef: 'artifact://terminal-output',
    fullOutputBytes: 21,
    fullOutputChars: 20,
    status: 'completed' as const,
    exitCode: 0,
  };
  const result = await reconcilePtcExecuteCodeInvocation(
    makeReconciliationArgs({
      cellReadoptionLedger: createReadoptionLedger(() => undefined),
      terminalResultStore: terminalStore({
        read: async () => ({ ok: true, value: completed }),
      }),
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'ptc_execute_code_store_unavailable',
    message:
      'PTC execute_code completed before restart; its durable terminal output must be claimed instead of starting duplicate code',
    remediation: 'Read terminalOutputRef to recover the completed cell output.',
    diagnostics: {
      cellId: CELL_ID,
      terminalOutputRef: 'artifact://terminal-output',
      terminalStatus: 'completed',
      terminalFullOutputBytes: 21,
      terminalFullOutputChars: 20,
      terminalExitCode: 0,
    },
  });

  await t.test('a terminal read failure remains fail-closed', async () => {
    const failed = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(() => undefined),
        terminalResultStore: terminalStore({
          read: async () => ({
            ok: false,
            message: 'terminal artifact is corrupt',
          }),
        }),
      }),
    );
    assert.deepEqual(failed, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'terminal artifact is corrupt',
    });
  });

  await t.test('a thrown terminal read remains fail-closed', async () => {
    const failed = await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: createReadoptionLedger(() => undefined),
        terminalResultStore: terminalStore({
          read: async () => {
            throw new Error('terminal storage offline');
          },
        }),
      }),
    );
    assert.deepEqual(failed, {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable terminal result could not be reconciled',
    });
  });
});

void test('invocation reconciliation distinguishes absent durable state from an unavailable terminal owner', async () => {
  const ledger = createReadoptionLedger(() => undefined);

  assert.deepEqual(
    await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: ledger,
      }),
    ),
    {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable terminal reconciliation is unavailable',
    },
  );
  assert.equal(
    await reconcilePtcExecuteCodeInvocation(
      makeReconciliationArgs({
        cellReadoptionLedger: ledger,
        terminalResultStore: terminalStore({
          read: async () => ({ ok: true, value: undefined }),
        }),
      }),
    ),
    undefined,
  );
});

function createReadoptionLedger(
  readRunningDelivery?: (
    args: Readonly<{ threadId: string; cellId: string }>,
  ) => PtcExecuteCodeRunningExecDelivery | undefined,
): ReturnType<typeof createPtcExecuteCodeCellReadoptionLedger> {
  const ledger = createPtcExecuteCodeCellReadoptionLedger({
    attachCellProcess: undefined,
    attachEpochCallbackController: undefined,
    cellRegistry: undefined,
    getStateRuntime: async () => ({
      ok: false,
      reasonCode: 'ptc_lab_session_unavailable',
      message: 'unused state runtime',
      diagnostics: { unused: true },
    }),
  });
  const store: PtcExecuteCodeCellCoordinateStore = {
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate: () => undefined,
    deletePtcExecuteCodeCellCoordinate: () => undefined,
    ...(readRunningDelivery === undefined
      ? {}
      : {
          readPtcExecuteCodeRunningExecDelivery: readRunningDelivery,
          persistPtcExecuteCodeRunningExecDelivery: () => undefined,
        }),
  };
  ledger.attachStore(store);
  return ledger;
}

function runningDelivery(
  overrides: Partial<PtcExecuteCodeRunningExecDelivery> = {},
): PtcExecuteCodeRunningExecDelivery {
  return {
    threadId: THREAD_ID,
    runId: INVOCATION.runId,
    callId: INVOCATION.callId,
    cellId: CELL_ID,
    stdout: '',
    stderr: '',
    durationMs: 500,
    toolCallbackCount: 0,
    outputReadOffsets: { stdoutBytes: 0, stderrBytes: 0 },
    ...overrides,
  };
}

function terminalStore(args: {
  read: PtcExecuteCodeCellTerminalResultStore['read'];
  readRecovery?: NonNullable<
    PtcExecuteCodeCellTerminalResultStore['readRecovery']
  >;
}): PtcExecuteCodeCellTerminalResultStore {
  return {
    async persist() {
      throw new Error('terminal persist is not expected during reconciliation');
    },
    read: args.read,
    ...(args.readRecovery === undefined
      ? {}
      : { readRecovery: args.readRecovery }),
  };
}

function makeReconciliationArgs(args: {
  cellReadoptionLedger: ReturnType<
    typeof createPtcExecuteCodeCellReadoptionLedger
  >;
  terminalResultStore?: PtcExecuteCodeCellTerminalResultStore;
}): Parameters<typeof reconcilePtcExecuteCodeInvocation>[0] {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(admission.ok, true);
  if (!admission.ok) {
    throw new Error('expected the lab profile to be admitted');
  }
  const callbackRuntime: PtcExecuteCodeCallbackRuntime = {
    enabled: false,
    toolCallbacksEnabled: false,
    observedCount: () => 0,
    callbackHandler: async () => ({
      ok: false,
      errorCode: 'ptc_callback_controller_recovering',
      message: 'unused callback handler',
    }),
  };
  return {
    admission: admission.value,
    callbackRuntime,
    cellId: CELL_ID,
    cellReadoptionLedger: args.cellReadoptionLedger,
    cellRegistry: undefined,
    effectiveTimeoutMs: 30_000,
    invocation: INVOCATION,
    runContext: {
      stateRoot: '/state/ptc-invocation-reconciliation',
      threadId: THREAD_ID,
    },
    sdkHelpBundle: buildPtcExecuteCodeSdkHelpBundle({
      callbacksEnabled: false,
      sdkHelp: undefined,
    }),
    terminalResultStore: args.terminalResultStore,
  };
}
