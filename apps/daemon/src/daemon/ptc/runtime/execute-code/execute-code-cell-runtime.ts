import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import {
  PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS,
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
  type PtcExecuteCodeCellTerminalResult,
} from './execute-code-cell-registry.js';
import {
  cellCleanupFailure,
  cellCloseDiagnostics,
  isProvenTerminatedCellCleanup,
  sanitizeDetachedOutputSegment,
  sensitiveBridgeMarkers,
  summarizeRunningCell,
} from './execute-code-cell-summary.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeResult,
} from './execute-code-runtime-contract.js';
import type { PtcExecuteCodeCallbackRuntime } from './execute-code-batch-runtime.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeReadOnlyCallbackEffectPolicy,
  type PtcExecuteCodeExecutionPlacement,
  type PtcExecuteCodePlacementBatchRunner,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
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
      cleanupFailure?: {
        message: string;
        diagnostics: Record<string, string | number | boolean>;
      };
    },
  ): Extract<PtcExecuteCodeRuntimeResult, { ok: true }>['value'];
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
  initialYieldTimeMs: number;
  maybeCreateCallbackBridge: PtcExecuteCodeCallbackBridgeFactory;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  getPlacementContinuityProvenance:
    | PtcExecuteCodePlacementContinuityProvenanceProvider
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

  let placement: PtcExecuteCodeExecutionPlacement;
  try {
    placement = await args.placementCoordinator.acquirePlacement({
      kind: 'detached_cell',
      cellId: admittedCell.cellId,
      continuity: classifyPtcExecuteCodePlacementContinuity(
        args.getPlacementContinuityProvenance?.({
          kind: 'detached_cell',
          cellId: admittedCell.cellId,
          identity: args.identity,
          request: args.request,
        }),
      ),
      callbackEffectPolicy: createPtcExecuteCodeReadOnlyCallbackEffectPolicy({
        callbackToolCount: args.sdkHelpBundle.callbacks.tools.length,
      }),
      identity: args.identity,
      sessionManager: args.sessionManager,
      batchRunner: args.batchRunner,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch (err: unknown) {
    args.cellRegistry.releaseAdmittingCell({
      threadId: args.identity.threadId,
      cellId: admittedCell.cellId,
    });
    throw err;
  }

  let releaseOnAttemptExit = true;
  let placementReleased = false;
  const releasePlacementOnce = async () => {
    if (placementReleased) {
      return;
    }
    placementReleased = true;
    await args.placementCoordinator.releasePlacement(placement);
  };
  const runtimeArgs: RunExecuteCodeCellRuntimeAttemptArgs = {
    ...args,
    identity: placement.identity,
    sessionManager: placement.sessionManager,
    onRunningCellSettled: async (settledArgs) => {
      await releasePlacementOnce();
      await args.onRunningCellSettled?.(settledArgs);
    },
  };

  try {
    const envelope = await createCellCommandEnvelope({
      cellId: admittedCell.cellId,
      runtimeArgs,
    });
    if (!envelope.ok) {
      return envelope.result;
    }

    const started = await startPromotedCellProcess({
      bridge: envelope.value.bridge,
      cellId: admittedCell.cellId,
      command: envelope.value.command,
      runtimeArgs,
    });
    if (!started.ok) {
      return started.result;
    }

    const result = await settleInitialCellWindow({
      runtimeArgs,
      started: started.value,
    });
    if (
      result.ok &&
      result.value.executionSurface === 'node_via_lab_detached_cell' &&
      result.value.status === 'running'
    ) {
      releaseOnAttemptExit = false;
    }
    return result;
  } finally {
    if (releaseOnAttemptExit) {
      await releasePlacementOnce();
    }
  }
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
        callbackPolicy: runtimeArgs.callbackRuntime.callbackPolicy,
        observedCount: runtimeArgs.callbackRuntime.observedCount,
        callbackHandler,
      }
    : {
        enabled: false,
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
    runtimeArgs.cellRegistry.releaseAdmittingCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
    });
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
  if (
    Buffer.byteLength(command, 'utf8') <=
    PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS
  ) {
    return { ok: true, value: { command, bridge } };
  }

  await runtimeArgs.closeCallbackBridge(bridge);
  runtimeArgs.cellRegistry.releaseAdmittingCell({
    threadId: runtimeArgs.identity.threadId,
    cellId: args.cellId,
  });
  const cleanup = await runtimeArgs.sessionManager.close(runtimeArgs.identity);
  return {
    ok: false,
    result: {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code command envelope is too large',
      ...(cleanup.ok
        ? {}
        : { diagnostics: { cleanupReasonCode: cleanup.reasonCode } }),
    },
  };
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
    runtimeArgs.cellRegistry.releaseAdmittingCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
    });
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
    runtimeArgs.cellRegistry.releaseAdmittingCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
    });
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
    },
  });
  if (!promoted.ok) {
    started.handle.terminate({
      graceMs: PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
    });
    await started.handle.exit;
    const bridgeClosed = await runtimeArgs.closeCallbackBridge(args.bridge);
    runtimeArgs.cellRegistry.releaseAdmittingCell({
      threadId: runtimeArgs.identity.threadId,
      cellId: args.cellId,
    });
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
      });
    }
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_cancelled',
      message: 'PTC execute_code cell was cancelled',
      diagnostics: { requestAborted: true },
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
      };
    }
    if (args.exit.kind === 'timeout') {
      return {
        ok: false,
        reasonCode: 'ptc_lab_command_timeout',
        message: 'PTC execute_code cell timed out',
        diagnostics: { cellExitKind: args.exit.kind },
      };
    }
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC execute_code cell process did not exit cleanly',
      diagnostics: { cellExitKind: args.exit.kind },
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
  return {
    ok: true,
    value: args.args.summarizeCompletedExecution(
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
        toolCallbacksEnabled: args.args.callbackRuntime.enabled,
        toolCallbackCount: args.args.callbackRuntime.observedCount(),
        sdkProtocolVersion: args.args.sdkHelpBundle.protocolVersion,
        sdkCallbackToolCount: args.args.sdkHelpBundle.callbacks.tools.length,
        sensitiveMarkers: [],
        ...(cleanupFailure !== undefined ? { cleanupFailure } : {}),
      },
    ),
  };
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
        });
        if (state?.cellId !== args.cellId || state.state !== 'running') {
          return;
        }
        const closed = await args.cellRegistry.closeCell({
          threadId: args.threadId,
          cellId: args.cellId,
          reason: 'run_terminal',
        });
        if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
          args.cellRegistry.recordCellCleanupFailure({
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
      });
      if (state?.cellId !== args.cellId || state.state !== 'running') {
        return;
      }
      const closed = await args.cellRegistry.closeCell({
        threadId: args.threadId,
        cellId: args.cellId,
        reason: 'run_terminal',
      });
      if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
        args.cellRegistry.recordCellCleanupFailure({
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
      });
      if (state?.cellId !== args.cellId || state.state !== 'running') {
        return;
      }
      const closed = await args.cellRegistry.closeCell({
        threadId: args.threadId,
        cellId: args.cellId,
        reason: 'run_terminal',
      });
      if (closed.ok && !isProvenTerminatedCellCleanup(closed)) {
        args.cellRegistry.recordCellCleanupFailure({
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
