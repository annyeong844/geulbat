import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import type { PtcExecuteCodeCallbackRuntime } from './execute-code-batch-runtime.js';
import type { createPtcExecuteCodeCellReadoptionLedger } from './execute-code-cell-readoption.js';
import type { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { summarizeRunningCell } from './execute-code-cell-summary.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodeCellTerminalResultStore,
  PtcExecuteCodeRuntimeResult,
} from './execute-code-runtime-contract.js';
import type { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

export async function reconcilePtcExecuteCodeInvocation(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: PtcExecuteCodeCallbackRuntime;
  cellId: PtcExecuteCodeCellId;
  cellReadoptionLedger: ReturnType<
    typeof createPtcExecuteCodeCellReadoptionLedger
  >;
  cellRegistry: ReturnType<typeof createPtcExecuteCodeCellRegistry> | undefined;
  effectiveTimeoutMs: number;
  invocation: {
    runId: string;
    callId: string;
  };
  runContext: {
    stateRoot: string;
    threadId: string;
  };
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  terminalResultStore: PtcExecuteCodeCellTerminalResultStore | undefined;
}): Promise<PtcExecuteCodeRuntimeResult | undefined> {
  if (!args.cellReadoptionLedger.supportsRunningExecDelivery()) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable running-result recovery is unavailable',
    };
  }

  let retainedDelivery: ReturnType<
    typeof args.cellReadoptionLedger.readRunningExecDelivery
  >;
  try {
    retainedDelivery = args.cellReadoptionLedger.readRunningExecDelivery({
      threadId: args.runContext.threadId,
      cellId: args.cellId,
    });
  } catch {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message:
        'PTC execute_code durable running result could not be reconciled',
    };
  }
  if (
    retainedDelivery !== undefined &&
    (retainedDelivery.runId !== args.invocation.runId ||
      retainedDelivery.callId !== args.invocation.callId)
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'PTC execute_code durable running result identity conflicts',
    };
  }

  const adoptedCoordinate = args.cellReadoptionLedger.getAdoptedCoordinate({
    threadId: args.runContext.threadId,
    cellId: args.cellId,
  });
  if (
    adoptedCoordinate !== undefined &&
    adoptedCoordinate.callbackToolNames.length > 0
  ) {
    const replaced = args.cellRegistry?.replaceRunningCellCallbackHandler({
      threadId: adoptedCoordinate.threadId,
      cellId: adoptedCoordinate.cellId,
      handler: (invocation) =>
        args.callbackRuntime.callbackHandler({
          ...invocation,
          cellId: adoptedCoordinate.cellId,
        }),
    });
    if (!replaced?.ok || !replaced.value.replaced) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message: 'PTC execute_code callback authority could not be restored',
      };
    }
  }

  if (retainedDelivery !== undefined) {
    return {
      ok: true,
      value: summarizeRunningCell({
        admission: args.admission,
        callbackRuntime: {
          ...args.callbackRuntime,
          observedCount: () => retainedDelivery.toolCallbackCount,
        },
        cellId: retainedDelivery.cellId,
        durationMs: retainedDelivery.durationMs,
        effectiveTimeoutMs: args.effectiveTimeoutMs,
        output: {
          stdout: retainedDelivery.stdout,
          stderr: retainedDelivery.stderr,
        },
        sdkHelpBundle: args.sdkHelpBundle,
      }),
    };
  }

  const terminalResultStore = args.terminalResultStore;
  if (terminalResultStore?.readRecovery !== undefined) {
    let recovery: Awaited<
      ReturnType<NonNullable<typeof terminalResultStore.readRecovery>>
    >;
    try {
      recovery = await terminalResultStore.readRecovery({
        stateRoot: args.runContext.stateRoot,
        threadId: args.runContext.threadId,
        cellId: args.cellId,
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message:
          'PTC execute_code durable terminal recovery could not be reconciled',
      };
    }
    if (!recovery.ok) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message: recovery.message,
      };
    }
    if (recovery.value !== undefined) {
      return recovery.value;
    }
  }

  if (args.terminalResultStore === undefined) {
    if (adoptedCoordinate === undefined) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message:
          'PTC execute_code durable terminal reconciliation is unavailable',
      };
    }
  } else {
    let terminal: Awaited<
      ReturnType<PtcExecuteCodeCellTerminalResultStore['read']>
    >;
    try {
      terminal = await args.terminalResultStore.read({
        stateRoot: args.runContext.stateRoot,
        threadId: args.runContext.threadId,
        cellId: args.cellId,
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message:
          'PTC execute_code durable terminal result could not be reconciled',
      };
    }
    if (!terminal.ok) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message: terminal.message,
      };
    }
    if (terminal.value !== undefined && adoptedCoordinate !== undefined) {
      terminal = { ok: true, value: undefined };
    }
    if (terminal.value !== undefined) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message:
          'PTC execute_code completed before restart; its durable terminal output must be claimed instead of starting duplicate code',
        remediation:
          'Read terminalOutputRef to recover the completed cell output.',
        diagnostics: {
          cellId: args.cellId,
          terminalOutputRef: terminal.value.outputRef,
          terminalStatus: terminal.value.status,
          terminalFullOutputBytes: terminal.value.fullOutputBytes,
          terminalFullOutputChars: terminal.value.fullOutputChars,
          ...(terminal.value.exitCode === null
            ? {}
            : { terminalExitCode: terminal.value.exitCode }),
        },
      };
    }
  }

  if (adoptedCoordinate === undefined || args.cellRegistry === undefined) {
    return undefined;
  }
  const prepared = args.cellRegistry.prepareRunningCellOutputDelivery({
    threadId: adoptedCoordinate.threadId,
    cellId: adoptedCoordinate.cellId,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'PTC execute_code re-adopted output delivery is unavailable',
    };
  }
  const durationMs = Math.max(0, Date.now() - adoptedCoordinate.createdAtMs);
  const toolCallbackCount = args.callbackRuntime.observedCount();
  try {
    args.cellReadoptionLedger.persistRunningExecDelivery({
      threadId: args.runContext.threadId,
      runId: args.invocation.runId,
      callId: args.invocation.callId,
      cellId: args.cellId,
      stdout: prepared.value.output.stdout,
      stderr: prepared.value.output.stderr,
      durationMs,
      toolCallbackCount,
      outputReadOffsets: prepared.value.offsets,
    });
  } catch {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'PTC execute_code re-adopted output could not be persisted',
    };
  }
  const committed = args.cellRegistry.commitRunningCellOutputDelivery({
    threadId: adoptedCoordinate.threadId,
    cellId: adoptedCoordinate.cellId,
  });
  if (!committed.ok) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_store_unavailable',
      message: 'PTC execute_code re-adopted output could not be committed',
    };
  }
  return {
    ok: true,
    value: summarizeRunningCell({
      admission: args.admission,
      callbackRuntime: args.callbackRuntime,
      cellId: args.cellId,
      durationMs,
      effectiveTimeoutMs: args.effectiveTimeoutMs,
      output: prepared.value.output,
      sdkHelpBundle: args.sdkHelpBundle,
    }),
  };
}
