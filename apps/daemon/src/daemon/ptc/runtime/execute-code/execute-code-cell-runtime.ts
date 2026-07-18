import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import {
  buildPtcLabBatchDockerExecArgs,
  type PtcLabBatchCommandExecutionSummary,
} from '../../lab/shell/lab-command-execution.js';
import { buildPtcLabPublicSessionId } from '../../lab/shell/lab-session-public-id.js';
import {
  closeTaintedPtcDockerSession,
  toPtcSessionTaintCloseDiagnostics,
} from '../../lab/session/session-taint-close.js';
import type {
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type { PtcEpochCallbackHandler } from '../../callback/epoch-callback.js';
import type {
  PtcSessionEpochBridge,
  PtcSessionEpochBridgeCallbackPolicy,
  PtcSessionEpochBridgeFailureReason,
} from '../../callback/session-epoch-bridge.js';
import {
  startPtcDockerClientProcess,
  type DetachedProcessExitInfo,
  type DetachedProcessHandle,
  type DetachedProcessOutputSegment,
} from '../../shared/process-command.js';
import type { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
  type createPtcExecuteCodeCellRegistry,
  type PtcExecuteCodeCellStoreFinalization,
  type PtcExecuteCodeCellTerminalResult,
} from './execute-code-cell-registry.js';
import {
  cellCleanupFailure,
  cellCloseDiagnostics,
  isProvenTerminatedCellCleanup,
  sanitizeDetachedOutputSegment,
  sensitiveBridgeMarkers,
  summarizeQueuedCell,
  summarizeRunningCell,
} from './execute-code-cell-summary.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodePlacementResourceSnapshotRef,
  PtcExecuteCodeRuntimeResult,
  PtcExecuteCodeRuntimeStoreSummary,
  PtcExecuteCodeRuntimeSummary,
} from './execute-code-runtime-contract.js';
import {
  buildPtcExecuteCodeStoreCommitFailure,
  createExecuteCodeStoreCallbackHandler,
  type PtcExecuteCodeCallbackRuntime,
} from './execute-code-batch-runtime.js';
import type {
  PtcExecuteCodeStore,
  PtcExecuteCodeStoreExecution,
} from './execute-code-store.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeCallbackEffectPolicy,
  type PtcExecuteCodeExecutionPlacement,
  type PtcExecuteCodePlacementBatchRunner,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
  type PtcExecuteCodePlacementReleaseResult,
  type PtcExecuteCodeQueuedPlacementAcquisition,
} from './execute-code-placement.js';

type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;

export type StartPtcExecuteCodeCellProcess = typeof startPtcDockerClientProcess;

interface PtcExecuteCodeValidatedRequest {
  code: string;
  timeoutMs: number;
}

interface PtcExecuteCodeCallbackBridgeFactory {
  (args: {
    callbackRuntime: PtcExecuteCodeCallbackRuntime;
    identity: PtcSessionDockerIdentity;
    sessionManager: PtcSessionDockerManager;
    createEpochBridge: PtcExecuteCodeEpochBridgeFactory | undefined;
    signal: AbortSignal | undefined;
  }): Promise<
    | { ok: true; value: { bridge?: PtcSessionEpochBridge } }
    | {
        ok: false;
        reasonCode: PtcSessionEpochBridgeFailureReason;
        message: string;
        diagnostics?: Record<string, string | number | boolean>;
      }
  >;
}

interface PtcExecuteCodeEpochBridgeFactory {
  (args: {
    identity: PtcSessionDockerIdentity;
    sessionManager: PtcSessionDockerManager;
    callbackHandler: PtcEpochCallbackHandler;
    callbackPolicy?: PtcSessionEpochBridgeCallbackPolicy;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; value: PtcSessionEpochBridge }
    | {
        ok: false;
        reasonCode: PtcSessionEpochBridgeFailureReason;
        message: string;
      }
  >;
}

interface PtcExecuteCodeCallbackBridgeCloser {
  (
    bridge: PtcSessionEpochBridge | undefined,
  ): Promise<{ ok: true } | { ok: false }>;
}

interface PtcExecuteCodeCommandBuilder {
  (
    code: string,
    args: {
      callbackConfig?: { socketPath: string; token: string };
      sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
    },
  ): string;
}

interface PtcExecuteCodeCompletedSummaryBuilder {
  (
    summary: PtcLabBatchCommandExecutionSummary,
    args: {
      toolCallbacksEnabled: boolean;
      toolCallbackCount: number;
      sdkProtocolVersion: ReturnType<
        typeof buildPtcExecuteCodeSdkHelpBundle
      >['protocolVersion'];
      sdkCallbackToolCount: number;
      sensitiveMarkers: string[];
      store?: PtcExecuteCodeRuntimeStoreSummary;
      cleanupFailure?: {
        message: string;
        diagnostics: Record<string, string | number | boolean>;
      };
    },
  ): Extract<
    PtcExecuteCodeRuntimeSummary,
    { executionSurface: 'node_via_lab_batch_command' }
  >;
}

type PtcExecuteCodeCellRuntimeFailureResult = Extract<
  PtcExecuteCodeRuntimeResult,
  { ok: false }
>;

type PtcExecuteCodeCellStepResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: PtcExecuteCodeCellRuntimeFailureResult };

interface RunExecuteCodeCellRuntimeAttemptArgs {
  admission: PtcLabAdmittedProfile;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
  buildCommand: PtcExecuteCodeCommandBuilder;
  callbackRuntime: PtcExecuteCodeCallbackRuntime;
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  closeCallbackBridge: PtcExecuteCodeCallbackBridgeCloser;
  createEpochBridge: PtcExecuteCodeEpochBridgeFactory | undefined;
  dockerPath: string | undefined;
  identity: PtcSessionDockerIdentity;
  ownerKind: 'root_main' | 'child';
  initialYieldTimeMs: number;
  maybeCreateCallbackBridge: PtcExecuteCodeCallbackBridgeFactory;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  getPlacementContinuityProvenance:
    | PtcExecuteCodePlacementContinuityProvenanceProvider
    | undefined;
  placementResourceSnapshotRef:
    | PtcExecuteCodePlacementResourceSnapshotRef
    | undefined;
  request: PtcExecuteCodeValidatedRequest;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  sessionManager: PtcSessionDockerManager;
  signal: AbortSignal | undefined;
  onRunningCellSettled?: (args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }) => Promise<void> | void;
  startCellProcess: StartPtcExecuteCodeCellProcess | undefined;
  store?: PtcExecuteCodeStore;
  finalizePlacement?: () => Promise<PtcExecuteCodePlacementReleaseResult>;
  finalizeStore?: (
    status: PtcExecuteCodeCellTerminalResult['status'],
  ) => Promise<PtcExecuteCodeCellStoreFinalization>;
  summarizeCompletedExecution: PtcExecuteCodeCompletedSummaryBuilder;
}

interface PtcExecuteCodeCellCommandEnvelope {
  command: string;
  bridge: PtcSessionEpochBridge | undefined;
}

interface PtcExecuteCodeStartedCellProcess {
  cellId: PtcExecuteCodeCellId;
  handle: DetachedProcessHandle;
  session: PtcSessionDockerHandle;
  startedAtMs: number;
}

export async function runExecuteCodeCellRuntimeAttempt(
  args: RunExecuteCodeCellRuntimeAttemptArgs,
): Promise<PtcExecuteCodeRuntimeResult> {
  const admittedCell = args.cellRegistry.reserveAdmittingCell({
    threadId: args.identity.threadId,
  });
  if (!admittedCell.ok) {
    const isUnclaimedResult =
      admittedCell.reasonCode === 'cell_result_unclaimed';
    return {
      ok: false,
      reasonCode: isUnclaimedResult
        ? 'ptc_execute_code_cell_result_unclaimed'
        : 'ptc_execute_code_cell_busy',
      message: isUnclaimedResult
        ? 'PTC execute_code cell has an unclaimed result; call wait for the reported cell before starting a new exec'
        : 'PTC execute_code cell is already running',
      diagnostics: {
        cellId: admittedCell.cellId,
        cellState: admittedCell.state,
      },
    };
  }

  let storeExecution: PtcExecuteCodeStoreExecution | undefined;
  if (args.store !== undefined) {
    const storeExecutionResult = await args.store.beginExecution({
      threadId: args.identity.threadId,
      executionId: admittedCell.cellId,
    });
    if (!storeExecutionResult.ok) {
      args.cellRegistry.releaseAdmittingCell({
        threadId: args.identity.threadId,
        cellId: admittedCell.cellId,
      });
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_unavailable',
        message: storeExecutionResult.error.message,
        storeError: storeExecutionResult.error,
      };
    }
    storeExecution = storeExecutionResult.value;
  }
  const finalizeStore =
    storeExecution === undefined
      ? undefined
      : createCellStoreFinalizer(storeExecution);

  let placementResult:
    | Awaited<
        ReturnType<PtcExecuteCodePlacementCoordinator['acquirePlacement']>
      >
    | undefined;
  try {
    placementResult = await args.placementCoordinator.acquirePlacement({
      kind: 'detached_cell',
      cellId: admittedCell.cellId,
      ownerKind: args.ownerKind,
      continuity: classifyPtcExecuteCodePlacementContinuity(
        args.getPlacementContinuityProvenance?.({
          kind: 'detached_cell',
          cellId: admittedCell.cellId,
          identity: args.identity,
          request: args.request,
        }),
      ),
      callbackEffectPolicy: createPtcExecuteCodeCallbackEffectPolicy({
        callbackToolCount: args.sdkHelpBundle.callbacks.tools.length,
        writeCallbackToolCount: args.sdkHelpBundle.callbacks.tools.filter(
          (tool) => tool.requiresApproval === true,
        ).length,
      }),
      identity: args.identity,
      sessionManager: args.sessionManager,
      batchRunner: args.batchRunner,
      ...(args.placementResourceSnapshotRef === undefined
        ? {}
        : { resourceSnapshotRef: args.placementResourceSnapshotRef }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch (err: unknown) {
    await finalizeStore?.('terminated');
    args.cellRegistry.releaseAdmittingCell({
      threadId: args.identity.threadId,
      cellId: admittedCell.cellId,
    });
    throw err;
  }
  if (!placementResult.ok) {
    await finalizeStore?.('terminated');
    args.cellRegistry.releaseAdmittingCell({
      threadId: args.identity.threadId,
      cellId: admittedCell.cellId,
    });
    return placementResult;
  }

  if ('queued' in placementResult) {
    const settlePromise = activateQueuedCellPlacement({
      args,
      cellId: admittedCell.cellId,
      finalizeStore,
      queuedPlacement: placementResult,
      storeExecution,
    });
    const queued = args.cellRegistry.markAdmittedCellQueued({
      threadId: args.identity.threadId,
      cellId: admittedCell.cellId,
      terminalResultStateRoot: args.identity.stateRoot,
      cancelAcquire: placementResult.cancel,
      settlePromise,
      ...(finalizeStore === undefined ? {} : { finalizeStore }),
    });
    if (!queued.ok) {
      placementResult.cancel();
      await settlePromise;
      await finalizeStore?.('terminated');
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message: 'PTC execute_code queued cell admission was lost',
      };
    }
    const callbackRuntime =
      storeExecution === undefined
        ? args.callbackRuntime
        : bindCellStoreCallbackRuntime(args.callbackRuntime, storeExecution);
    return {
      ok: true,
      value: summarizeQueuedCell({
        admission: args.admission,
        callbackRuntime,
        cellId: admittedCell.cellId,
        effectiveTimeoutMs: args.request.timeoutMs,
        sdkHelpBundle: args.sdkHelpBundle,
      }),
    };
  }

  const placement = placementResult.value;

  let releaseOnAttemptExit = true;
  let placementReleased = false;
  let placementReleaseResult: PtcExecuteCodePlacementReleaseResult | undefined;
  const releasePlacementOnce =
    async (): Promise<PtcExecuteCodePlacementReleaseResult> => {
      if (placementReleased) {
        return placementReleaseResult ?? { ok: true };
      }
      placementReleased = true;
      placementReleaseResult = normalizePlacementReleaseResult(
        await args.placementCoordinator.releasePlacement(placement),
      );
      return placementReleaseResult;
    };
  const runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs = {
    ...args,
    callbackRuntime:
      storeExecution === undefined
        ? args.callbackRuntime
        : bindCellStoreCallbackRuntime(args.callbackRuntime, storeExecution),
    ...(finalizeStore === undefined ? {} : { finalizeStore }),
    finalizePlacement: releasePlacementOnce,
    identity: placement.identity,
    sessionManager: placement.sessionManager,
    onRunningCellSettled: async (settledArgs) => {
      await args.onRunningCellSettled?.(settledArgs);
    },
  };

  try {
    const envelope = await createCellCommandEnvelope({
      cellId: admittedCell.cellId,
      runtimeArgs,
    });
    if (!envelope.ok) {
      return await attachDiscardedCellStore(envelope.result, finalizeStore);
    }

    const started = await startPromotedCellProcess({
      bridge: envelope.value.bridge,
      cellId: admittedCell.cellId,
      command: envelope.value.command,
      runtimeArgs,
    });
    if (!started.ok) {
      return await attachDiscardedCellStore(started.result, finalizeStore);
    }

    let result = await settleInitialCellWindow({
      runtimeArgs,
      started: started.value,
    });
    if (
      result.ok &&
      result.value.executionSurface === 'node_via_lab_detached_cell' &&
      result.value.status === 'running'
    ) {
      releaseOnAttemptExit = false;
      return result;
    }
    args.cellRegistry.releaseAdmittingCell({
      threadId: args.identity.threadId,
      cellId: admittedCell.cellId,
    });
    await finalizeStore?.('terminated');
    const released = await releasePlacementOnce();
    releaseOnAttemptExit = false;
    result = attachPlacementReleaseFailure(result, released);
    return result;
  } finally {
    if (releaseOnAttemptExit) {
      args.cellRegistry.releaseAdmittingCell({
        threadId: args.identity.threadId,
        cellId: admittedCell.cellId,
      });
      await finalizeStore?.('terminated');
      await releasePlacementOnce();
    }
  }
}

async function activateQueuedCellPlacement(args: {
  args: RunExecuteCodeCellRuntimeAttemptArgs;
  cellId: PtcExecuteCodeCellId;
  finalizeStore: RunExecuteCodeCellRuntimeAttemptArgs['finalizeStore'];
  queuedPlacement: PtcExecuteCodeQueuedPlacementAcquisition;
  storeExecution: PtcExecuteCodeStoreExecution | undefined;
}): Promise<void> {
  const runtimeArgs = args.args;
  let placement: PtcExecuteCodeExecutionPlacement | undefined;
  let placementReleased = false;
  let placementReleaseResult: PtcExecuteCodePlacementReleaseResult | undefined;
  const releasePlacementOnce =
    async (): Promise<PtcExecuteCodePlacementReleaseResult> => {
      if (placement === undefined || placementReleased) {
        return placementReleaseResult ?? { ok: true };
      }
      placementReleased = true;
      placementReleaseResult = normalizePlacementReleaseResult(
        await runtimeArgs.placementCoordinator.releasePlacement(placement),
      );
      return placementReleaseResult;
    };
  const notifySettled = async () => {
    await runtimeArgs.onRunningCellSettled?.({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
    });
  };
  const recordStartFailure = async (
    failure: PtcExecuteCodeCellRuntimeFailureResult,
  ) => {
    const released = await releasePlacementOnce();
    const finalResult = attachPlacementReleaseFailure(failure, released);
    await runtimeArgs.cellRegistry.recordCellStartFailure({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
      failure: finalResult.ok
        ? {
            ok: false,
            reasonCode: 'ptc_execute_code_invalid',
            message: 'PTC execute_code queued cell start failed',
          }
        : finalResult,
    });
    await notifySettled();
  };

  try {
    const settledPlacement = await args.queuedPlacement.waitForPlacement;
    if (!settledPlacement.ok) {
      await recordStartFailure(settledPlacement);
      return;
    }
    placement = settledPlacement.value;
    const callbackRuntime =
      args.storeExecution === undefined
        ? runtimeArgs.callbackRuntime
        : bindCellStoreCallbackRuntime(
            runtimeArgs.callbackRuntime,
            args.storeExecution,
          );
    const queuedRuntimeArgs: RunExecuteCodeCellRuntimeAttemptArgs = {
      ...runtimeArgs,
      callbackRuntime,
      ...(args.finalizeStore === undefined
        ? {}
        : { finalizeStore: args.finalizeStore }),
      finalizePlacement: releasePlacementOnce,
      identity: placement.identity,
      sessionManager: placement.sessionManager,
      onRunningCellSettled: async (settledArgs) => {
        await runtimeArgs.onRunningCellSettled?.(settledArgs);
      },
    };
    const envelope = await createCellCommandEnvelope({
      cellId: args.cellId,
      runtimeArgs: queuedRuntimeArgs,
    });
    if (!envelope.ok) {
      await recordStartFailure(envelope.result);
      return;
    }
    const started = await startPromotedCellProcess({
      bridge: envelope.value.bridge,
      cellId: args.cellId,
      command: envelope.value.command,
      runtimeArgs: queuedRuntimeArgs,
    });
    if (!started.ok) {
      await recordStartFailure(started.result);
      return;
    }
    trackRunningCellCompletion({
      runtimeArgs: queuedRuntimeArgs,
      started: started.value,
    });
  } catch {
    await recordStartFailure({
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC execute_code queued cell failed to start',
      diagnostics: { queuedCellActivationThrew: true },
    });
  }
}

function normalizePlacementReleaseResult(
  result: void | PtcExecuteCodePlacementReleaseResult,
): PtcExecuteCodePlacementReleaseResult {
  return result ?? { ok: true };
}

function attachPlacementReleaseFailure(
  result: PtcExecuteCodeRuntimeResult,
  released: PtcExecuteCodePlacementReleaseResult,
): PtcExecuteCodeRuntimeResult {
  if (released.ok) {
    return result;
  }
  if (
    result.ok &&
    result.value.executionSurface === 'node_via_lab_batch_command'
  ) {
    return {
      ok: true,
      value: {
        ...result.value,
        cleanupFailure: {
          message: released.message,
          diagnostics: released.diagnostics,
        },
      },
    };
  }
  return cellCleanupFailure({
    message: released.message,
    diagnostics: {
      ...released.diagnostics,
      ...(result.ok ? {} : { startFailureReasonCode: result.reasonCode }),
    },
  });
}

async function createCellCommandEnvelope(args: {
  cellId: PtcExecuteCodeCellId;
  runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs;
}): Promise<PtcExecuteCodeCellStepResult<PtcExecuteCodeCellCommandEnvelope>> {
  const runtimeArgs = args.runtimeArgs;
  const callbackHandler: PtcEpochCallbackHandler = (invocation) =>
    runtimeArgs.callbackRuntime.callbackHandler({
      ...invocation,
      cellId: args.cellId,
    });
  const callbackRuntime: PtcExecuteCodeCallbackRuntime = runtimeArgs
    .callbackRuntime.enabled
    ? {
        enabled: true,
        toolCallbacksEnabled: runtimeArgs.callbackRuntime.toolCallbacksEnabled,
        callbackPolicy: runtimeArgs.callbackRuntime.callbackPolicy,
        observedCount: runtimeArgs.callbackRuntime.observedCount,
        callbackHandler,
      }
    : {
        enabled: false,
        toolCallbacksEnabled: runtimeArgs.callbackRuntime.toolCallbacksEnabled,
        observedCount: runtimeArgs.callbackRuntime.observedCount,
        callbackHandler,
      };
  const bridgeResult = await runtimeArgs.maybeCreateCallbackBridge({
    callbackRuntime,
    identity: runtimeArgs.identity,
    sessionManager: runtimeArgs.sessionManager,
    createEpochBridge: runtimeArgs.createEpochBridge,
    signal: runtimeArgs.signal,
  });
  if (!bridgeResult.ok) {
    const cleanup = await runtimeArgs.sessionManager.close(
      runtimeArgs.identity,
    );
    return {
      ok: false,
      result: {
        ok: false,
        reasonCode: 'ptc_execute_code_callback_bridge_unavailable',
        message: bridgeResult.message,
        diagnostics: {
          ...(bridgeResult.diagnostics ?? {}),
          bridgeReasonCode: bridgeResult.reasonCode,
          ...(cleanup.ok ? {} : { cleanupReasonCode: cleanup.reasonCode }),
        },
      },
    };
  }

  const bridge = bridgeResult.value.bridge;
  const command = runtimeArgs.buildCommand(runtimeArgs.request.code, {
    sdkHelpBundle: runtimeArgs.sdkHelpBundle,
    ...(bridge === undefined
      ? {}
      : {
          callbackConfig: {
            socketPath: bridge.callbackSocketContainerPath,
            token: bridge.token,
          },
        }),
  });
  return { ok: true, value: { command, bridge } };
}

async function startPromotedCellProcess(args: {
  bridge: PtcSessionEpochBridge | undefined;
  cellId: PtcExecuteCodeCellId;
  command: string;
  runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs;
}): Promise<PtcExecuteCodeCellStepResult<PtcExecuteCodeStartedCellProcess>> {
  const runtimeArgs = args.runtimeArgs;
  const session = await runtimeArgs.sessionManager.getOrCreate(
    runtimeArgs.identity,
    runtimeArgs.signal === undefined
      ? undefined
      : { signal: runtimeArgs.signal },
  );
  if (!session.ok) {
    await runtimeArgs.closeCallbackBridge(args.bridge);
    return {
      ok: false,
      result: {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC lab session container is unavailable',
        diagnostics: { sessionReasonCode: session.reasonCode },
      },
    };
  }

  const startedAtMs = Date.now();
  const started = (runtimeArgs.startCellProcess ?? startPtcDockerClientProcess)(
    {
      executable: runtimeArgs.dockerPath ?? 'docker',
      args: buildPtcLabBatchDockerExecArgs({
        containerId: session.value.containerId,
        interpreter: 'bash',
        command: args.command,
      }),
      timeoutMs: runtimeArgs.request.timeoutMs,
      redactionMarkers: sensitiveBridgeMarkers(args.bridge),
      redactionReplacement: '[redacted:ptc-callback]',
      ...(runtimeArgs.admission.labPolicy === undefined
        ? {}
        : {
            outputBufferPolicy: {
              maxBufferedBytesPerStream:
                runtimeArgs.admission.labPolicy.shell.maxBufferedBytesPerStream,
            },
          }),
    },
  );
  if (!started.ok) {
    await runtimeArgs.closeCallbackBridge(args.bridge);
    return {
      ok: false,
      result: {
        ok: false,
        reasonCode: 'ptc_lab_command_failed',
        message: 'PTC execute_code cell process failed to start',
        diagnostics: { spawnFailed: true },
      },
    };
  }

  const promoted = runtimeArgs.cellRegistry.promoteAdmittedCell({
    threadId: runtimeArgs.identity.threadId,
    cellId: args.cellId,
    resources: {
      effectiveTimeoutMs: runtimeArgs.request.timeoutMs,
      handle: started.handle,
      closeBridge: async () => {
        const closed = await runtimeArgs.closeCallbackBridge(args.bridge);
        if (!closed.ok) {
          throw new Error('PTC execute_code callback bridge close failed');
        }
      },
      taintSession: async () => {
        const outcome = await closeTaintedPtcDockerSession({
          identity: runtimeArgs.identity,
          sessionManager: runtimeArgs.sessionManager,
        });
        return outcome.closeProven;
      },
      ...(runtimeArgs.finalizePlacement === undefined
        ? {}
        : { finalizePlacement: runtimeArgs.finalizePlacement }),
      ...(runtimeArgs.finalizeStore === undefined
        ? {}
        : { finalizeStore: runtimeArgs.finalizeStore }),
    },
  });
  if (!promoted.ok) {
    started.handle.terminate({
      graceMs: PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
    });
    await started.handle.exit;
    const bridgeClosed = await runtimeArgs.closeCallbackBridge(args.bridge);
    const taint = await closeTaintedPtcDockerSession({
      identity: runtimeArgs.identity,
      sessionManager: runtimeArgs.sessionManager,
    });
    const taintDiagnostics = toPtcSessionTaintCloseDiagnostics(taint);
    if (!bridgeClosed.ok || taintDiagnostics !== undefined) {
      return {
        ok: false,
        result: cellCleanupFailure({
          message: 'PTC execute_code cell cleanup failed after admission loss',
          diagnostics: {
            cellAdmissionLost: true,
            ...(bridgeClosed.ok ? {} : { callbackBridgeCloseFailed: true }),
            ...(taintDiagnostics ?? {}),
          },
        }),
      };
    }
    return {
      ok: false,
      result: {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message: 'PTC execute_code cell admission was lost',
      },
    };
  }

  return {
    ok: true,
    value: {
      cellId: args.cellId,
      handle: started.handle,
      session: session.value,
      startedAtMs,
    },
  };
}

async function settleInitialCellWindow(args: {
  runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs;
  started: PtcExecuteCodeStartedCellProcess;
}): Promise<PtcExecuteCodeRuntimeResult> {
  const runtimeArgs = args.runtimeArgs;
  const initial = await waitForInitialCellWindow({
    handle: args.started.handle,
    signal: runtimeArgs.signal,
    yieldTimeMs: runtimeArgs.initialYieldTimeMs,
  });
  const durationMs = Math.max(0, Date.now() - args.started.startedAtMs);
  if (initial.kind === 'abort') {
    const closed = await runtimeArgs.cellRegistry.closeCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.started.cellId,
      reason: 'run_abort',
    });
    if (!closed.ok || !isProvenTerminatedCellCleanup(closed)) {
      return cellCleanupFailure({
        message: 'PTC execute_code cell cleanup failed after cancellation',
        diagnostics: {
          requestAborted: true,
          ...cellCloseDiagnostics(closed),
        },
        ...closedCellStoreSummary(closed),
      });
    }
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_cancelled',
      message: 'PTC execute_code cell was cancelled',
      diagnostics: { requestAborted: true },
      ...closedCellStoreSummary(closed),
    };
  }
  if (initial.kind === 'exit') {
    return await finishInitialCellExit({
      args: runtimeArgs,
      cellId: args.started.cellId,
      durationMs,
      exit: initial.exit,
      handle: args.started.handle,
      session: args.started.session,
    });
  }

  const persistenceMarked =
    runtimeArgs.cellRegistry.markRunningCellTerminalResultPersistence({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.started.cellId,
      stateRoot: runtimeArgs.identity.stateRoot,
    });
  if (!persistenceMarked.ok) {
    const closed = await runtimeArgs.cellRegistry.closeCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.started.cellId,
      reason: 'run_terminal',
    });
    return cellCleanupFailure({
      message:
        'PTC execute_code cell durable terminal result handoff could not be armed',
      diagnostics: {
        terminalResultPersistenceAdmissionLost: true,
        ...cellCloseDiagnostics(closed),
      },
      ...closedCellStoreSummary(closed),
    });
  }

  trackRunningCellCompletion({ runtimeArgs, started: args.started });
  return {
    ok: true,
    value: summarizeRunningCell({
      admission: runtimeArgs.admission,
      callbackRuntime: runtimeArgs.callbackRuntime,
      cellId: args.started.cellId,
      durationMs,
      effectiveTimeoutMs: runtimeArgs.request.timeoutMs,
      output: initial.output,
      sdkHelpBundle: runtimeArgs.sdkHelpBundle,
    }),
  };
}

function trackRunningCellCompletion(args: {
  runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs;
  started: PtcExecuteCodeStartedCellProcess;
}): void {
  const runtimeArgs = args.runtimeArgs;
  const ownerSignal = runtimeArgs.signal;
  let releaseOwnerAbort = () => {};
  if (ownerSignal !== undefined) {
    const closeOnOwnerAbort = () => {
      void runtimeArgs.cellRegistry.closeCell({
        threadId: runtimeArgs.identity.threadId,
        cellId: args.started.cellId,
        reason: 'run_abort',
      });
    };
    ownerSignal.addEventListener('abort', closeOnOwnerAbort, { once: true });
    releaseOwnerAbort = () => {
      ownerSignal.removeEventListener('abort', closeOnOwnerAbort);
    };
    if (ownerSignal.aborted) {
      releaseOwnerAbort();
      closeOnOwnerAbort();
    }
  }

  void recordCellCompletion({
    cellRegistry: runtimeArgs.cellRegistry,
    cellId: args.started.cellId,
    handle: args.started.handle,
    onSettled: async () => {
      releaseOwnerAbort();
      await runtimeArgs.onRunningCellSettled?.({
        threadId: runtimeArgs.identity.threadId,
        cellId: args.started.cellId,
      });
    },
    threadId: runtimeArgs.identity.threadId,
  });
}

async function waitForInitialCellWindow(args: {
  handle: DetachedProcessHandle;
  signal: AbortSignal | undefined;
  yieldTimeMs: number;
}): Promise<
  | { kind: 'exit'; exit: DetachedProcessExitInfo }
  | { kind: 'abort' }
  | { kind: 'yield'; output: DetachedProcessOutputSegment }
> {
  if (args.signal?.aborted === true) {
    return { kind: 'abort' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: 'abort' });
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      args.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (
      result:
        | { kind: 'exit'; exit: DetachedProcessExitInfo }
        | { kind: 'abort' }
        | { kind: 'yield' },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result.kind === 'yield') {
        resolve({ kind: 'yield', output: args.handle.drainNewOutput() });
        return;
      }
      resolve(result);
    };

    args.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: 'yield' }), args.yieldTimeMs);
    timer.unref?.();
    void args.handle.exit.then((exit) => finish({ kind: 'exit', exit }));
  });
}

async function finishInitialCellExit(args: {
  args: Parameters<typeof runExecuteCodeCellRuntimeAttempt>[0];
  cellId: PtcExecuteCodeCellId;
  durationMs: number;
  exit: DetachedProcessExitInfo;
  handle: DetachedProcessHandle;
  session: PtcSessionDockerHandle;
}): Promise<PtcExecuteCodeRuntimeResult> {
  const output = args.handle.drainNewOutput();
  if (args.exit.kind !== 'exit') {
    const closed = await args.args.cellRegistry.closeCell({
      threadId: args.args.identity.threadId,
      cellId: args.cellId,
      reason: 'run_terminal',
    });
    if (!closed.ok || !isProvenTerminatedCellCleanup(closed)) {
      return cellCleanupFailure({
        message: 'PTC execute_code cell cleanup failed after terminal signal',
        diagnostics: {
          cellExitKind: args.exit.kind,
          ...cellCloseDiagnostics(closed),
        },
        ...closedCellStoreSummary(closed),
      });
    }
    if (args.exit.kind === 'output_limit_exceeded') {
      return {
        ok: false,
        reasonCode: 'ptc_lab_command_output_rejected',
        message:
          'PTC execute_code cell output exceeded the policy buffer budget',
        diagnostics: {
          outputStream: args.exit.stream,
          maxBufferedBytesPerStream: args.exit.maxBufferedBytesPerStream,
        },
        ...closedCellStoreSummary(closed),
      };
    }
    if (args.exit.kind === 'timeout') {
      return {
        ok: false,
        reasonCode: 'ptc_lab_command_timeout',
        message: 'PTC execute_code cell timed out',
        diagnostics: { cellExitKind: args.exit.kind },
        ...closedCellStoreSummary(closed),
      };
    }
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC execute_code cell process did not exit cleanly',
      diagnostics: { cellExitKind: args.exit.kind },
      ...closedCellStoreSummary(closed),
    };
  }

  const recorded = await args.args.cellRegistry.recordTerminalCellResult({
    threadId: args.args.identity.threadId,
    cellId: args.cellId,
    result: {
      status: 'completed',
      output,
      exit: args.exit,
    },
  });
  const claimed = args.args.cellRegistry.takeTerminalCellResult({
    threadId: args.args.identity.threadId,
    cellId: args.cellId,
  });
  if (!recorded.ok || !claimed.ok) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code cell result was unavailable',
    };
  }
  let terminalResult: PtcExecuteCodeCellTerminalResult;
  let cleanupFailure:
    | {
        message: string;
        diagnostics: Record<string, string | number | boolean>;
      }
    | undefined;
  if (claimed.value.status === 'start_failed') {
    return claimed.value.failure;
  }
  if (claimed.value.status === 'cleanup_failed') {
    cleanupFailure = {
      message: claimed.value.message,
      diagnostics: claimed.value.diagnostics,
    };
    if (claimed.value.terminalResult === undefined) {
      return cellCleanupFailure(cleanupFailure);
    }
    terminalResult = claimed.value.terminalResult;
  } else {
    cleanupFailure = undefined;
    terminalResult = claimed.value;
  }
  if (terminalResult.exit.kind !== 'exit') {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code cell result was unavailable',
    };
  }

  const sanitizedOutput = sanitizeDetachedOutputSegment(terminalResult.output);
  const execution = args.args.summarizeCompletedExecution(
    {
      ok: true,
      profile: 'lab',
      policyId:
        args.args.admission.labPolicy?.policyId ??
        args.args.admission.metadata.policyId,
      labSessionId: buildPtcLabPublicSessionId(args.session),
      containerId: args.session.containerId,
      executionClass: 'lab_batch_command',
      interpreter: 'bash',
      exitCode: terminalResult.exit.exitCode,
      stdout: sanitizedOutput.stdout,
      stderr: sanitizedOutput.stderr,
      effectiveTimeoutMs: args.args.request.timeoutMs,
      durationMs: args.durationMs,
    },
    {
      toolCallbacksEnabled: args.args.callbackRuntime.toolCallbacksEnabled,
      toolCallbackCount: args.args.callbackRuntime.observedCount(),
      sdkProtocolVersion: args.args.sdkHelpBundle.protocolVersion,
      sdkCallbackToolCount: args.args.sdkHelpBundle.callbacks.tools.length,
      sensitiveMarkers: [],
      ...(terminalResult.store === undefined
        ? {}
        : { store: terminalResult.store }),
      ...(cleanupFailure !== undefined ? { cleanupFailure } : {}),
    },
  );
  if (terminalResult.storeError !== undefined) {
    return buildPtcExecuteCodeStoreCommitFailure(
      terminalResult.storeError,
      execution,
      readDiscardedStoreWriteCount(terminalResult.store),
    );
  }
  return {
    ok: true,
    value: execution,
  };
}

function bindCellStoreCallbackRuntime(
  callbackRuntime: PtcExecuteCodeCallbackRuntime,
  execution: PtcExecuteCodeStoreExecution,
): PtcExecuteCodeCallbackRuntime {
  const storeCallbackHandler = createExecuteCodeStoreCallbackHandler({
    execution,
  });
  return {
    ...callbackRuntime,
    callbackHandler: async (invocation) =>
      invocation.kind === 'store_get' || invocation.kind === 'store_set'
        ? await storeCallbackHandler(invocation)
        : await callbackRuntime.callbackHandler(invocation),
  };
}

function createCellStoreFinalizer(
  execution: PtcExecuteCodeStoreExecution,
): (
  status: PtcExecuteCodeCellTerminalResult['status'],
) => Promise<PtcExecuteCodeCellStoreFinalization> {
  let finalization: Promise<PtcExecuteCodeCellStoreFinalization> | undefined;
  return (status) => {
    if (finalization !== undefined) {
      return finalization;
    }
    if (status === 'terminated') {
      finalization = Promise.resolve({ store: execution.discard() });
      return finalization;
    }
    const pendingWriteCount = execution.pendingWriteCount();
    finalization = execution.commit().then((result) =>
      result.ok
        ? { store: result.value }
        : {
            store: { discardedWrites: pendingWriteCount },
            storeError: result.error,
          },
    );
    return finalization;
  };
}

function readDiscardedStoreWriteCount(
  store: PtcExecuteCodeRuntimeStoreSummary | undefined,
): number {
  return store !== undefined && 'discardedWrites' in store
    ? store.discardedWrites
    : 0;
}

async function attachDiscardedCellStore(
  result: PtcExecuteCodeCellRuntimeFailureResult,
  finalizeStore:
    | ((
        status: PtcExecuteCodeCellTerminalResult['status'],
      ) => Promise<PtcExecuteCodeCellStoreFinalization>)
    | undefined,
): Promise<PtcExecuteCodeCellRuntimeFailureResult> {
  if (finalizeStore === undefined || result.store !== undefined) {
    return result;
  }
  const finalization = await finalizeStore('terminated');
  return finalization.store !== undefined &&
    'discardedWrites' in finalization.store
    ? { ...result, store: finalization.store }
    : result;
}

type PtcExecuteCodeCellCloseResult = Awaited<
  ReturnType<ReturnType<CreatePtcExecuteCodeCellRegistry>['closeCell']>
>;

function closedCellStoreSummary(result: PtcExecuteCodeCellCloseResult): {
  store?: Extract<
    PtcExecuteCodeRuntimeStoreSummary,
    { discardedWrites: number }
  >;
} {
  return result.ok &&
    result.status === 'terminated' &&
    result.store !== undefined &&
    'discardedWrites' in result.store
    ? { store: result.store }
    : {};
}

async function recordCellCompletion(args: {
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  cellId: PtcExecuteCodeCellId;
  handle: DetachedProcessHandle;
  onSettled?: () => Promise<void> | void;
  threadId: string;
}): Promise<void> {
  try {
    const exit = await args.handle.exit;
    if (exit.kind === 'output_limit_exceeded' || exit.kind === 'timeout') {
      const recorded = await args.cellRegistry.recordTerminalCellResult({
        threadId: args.threadId,
        cellId: args.cellId,
        result: {
          status: 'terminated',
          output: args.handle.drainNewOutput(),
          exit,
        },
      });
      if (!recorded.ok) {
        const state = args.cellRegistry.readCellState({
          threadId: args.threadId,
          cellId: args.cellId,
        });
        if (state?.state !== 'running') {
          return;
        }
        const closed = await args.cellRegistry.closeCell({
          threadId: args.threadId,
          cellId: args.cellId,
          reason: 'run_terminal',
        });
        if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
          await args.cellRegistry.recordCellCleanupFailure({
            threadId: args.threadId,
            cellId: args.cellId,
            message: 'PTC execute_code cell cleanup failed',
            diagnostics: {
              cellExitKind: exit.kind,
              ...cellCloseDiagnostics(closed),
            },
          });
        }
      }
      return;
    }
    if (exit.kind !== 'exit') {
      const state = args.cellRegistry.readCellState({
        threadId: args.threadId,
        cellId: args.cellId,
      });
      if (state?.state !== 'running') {
        return;
      }
      const closed = await args.cellRegistry.closeCell({
        threadId: args.threadId,
        cellId: args.cellId,
        reason: 'run_terminal',
      });
      if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
        await args.cellRegistry.recordCellCleanupFailure({
          threadId: args.threadId,
          cellId: args.cellId,
          message: 'PTC execute_code cell cleanup failed after terminal signal',
          diagnostics: {
            cellExitKind: exit.kind,
            ...cellCloseDiagnostics(closed),
          },
        });
      }
      return;
    }

    const recorded = await args.cellRegistry.recordTerminalCellResult({
      threadId: args.threadId,
      cellId: args.cellId,
      result: {
        status: 'completed',
        output: args.handle.drainNewOutput(),
        exit,
      },
    });
    if (!recorded.ok) {
      const state = args.cellRegistry.readCellState({
        threadId: args.threadId,
        cellId: args.cellId,
      });
      if (state?.state !== 'running') {
        return;
      }
      const closed = await args.cellRegistry.closeCell({
        threadId: args.threadId,
        cellId: args.cellId,
        reason: 'run_terminal',
      });
      if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
        await args.cellRegistry.recordCellCleanupFailure({
          threadId: args.threadId,
          cellId: args.cellId,
          message: 'PTC execute_code cell cleanup failed',
          diagnostics: cellCloseDiagnostics(closed),
        });
      }
    }
  } finally {
    await args.onSettled?.();
  }
}
