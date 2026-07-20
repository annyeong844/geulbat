// PTC execute_code 셀 정산 — 프로세스가 시작·승격된 뒤의 국면을 소유한다:
// 초기 yield 윈도우 정산(조기 종료/중단/양보)과, running으로 반환된 뒤의
// 백그라운드 완주 추적(terminal 결과 기록·정리 실패 각인). cell-runtime의
// attempt 오케스트레이터가 settleInitialCellWindow/trackRunningCellCompletion
// 두 진입점만 부른다. 결합은 attempt args bag 전체가 아니라 정산이 실제로
// 읽는 필드만 좁힌 SettlementContext로 받는다(구조적 타이핑으로 bag이 그대로
// 들어온다) — cell-runtime으로의 역참조(순환)를 만들지 않기 위함이다.
import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import { buildPtcLabPublicSessionId } from '../../lab/shell/lab-session-public-id.js';
import type {
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
} from '../../lab/session/session-docker-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from './execute-code-cell-process.js';
import type { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';
import type { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import type { PtcExecuteCodeCellTerminalResult } from './execute-code-cell-terminal-retention.js';
import {
  cellCleanupFailure,
  cellCloseDiagnostics,
  isProvenTerminatedCellCleanup,
  sanitizeDetachedOutputSegment,
  summarizeRunningCell,
} from './execute-code-cell-summary.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeResult,
  PtcExecuteCodeRuntimeStoreSummary,
  PtcExecuteCodeRuntimeSummary,
} from './execute-code-runtime-contract.js';
import {
  buildPtcExecuteCodeStoreCommitFailure,
  type PtcExecuteCodeCallbackRuntime,
} from './execute-code-batch-runtime.js';
import type { PtcLabBatchCommandExecutionSummary } from '../../lab/shell/lab-command-execution.js';

type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;

export interface PtcExecuteCodeCompletedSummaryBuilder {
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

export interface PtcExecuteCodeStartedCellProcess {
  cellId: PtcExecuteCodeCellId;
  handle: DetachedProcessHandle;
  session: PtcSessionDockerHandle;
  startedAtMs: number;
}

// attempt args bag(cell-runtime 소유)에서 정산 국면이 실제로 읽는 필드만 —
// bag이 구조적으로 이 계약을 충족하므로 호출부는 bag을 그대로 넘긴다.
interface PtcExecuteCodeCellSettlementContext {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: PtcExecuteCodeCallbackRuntime;
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  identity: PtcSessionDockerIdentity;
  initialYieldTimeMs: number;
  request: { timeoutMs: number };
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  signal: AbortSignal | undefined;
  onRunningCellSettled?: (args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }) => Promise<void> | void;
  summarizeCompletedExecution: PtcExecuteCodeCompletedSummaryBuilder;
}

export async function settleInitialCellWindow(args: {
  runtimeArgs: PtcExecuteCodeCellSettlementContext;
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

export function trackRunningCellCompletion(args: {
  runtimeArgs: PtcExecuteCodeCellSettlementContext;
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
  args: PtcExecuteCodeCellSettlementContext;
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

function readDiscardedStoreWriteCount(
  store: PtcExecuteCodeRuntimeStoreSummary | undefined,
): number {
  return store !== undefined && 'discardedWrites' in store
    ? store.discardedWrites
    : 0;
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
