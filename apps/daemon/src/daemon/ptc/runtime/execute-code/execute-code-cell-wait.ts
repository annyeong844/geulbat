import type { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import {
  cellCleanupFailure,
  cellCloseDiagnostics,
  isProvenTerminatedCellCleanup,
  summarizeWaitClosedCell,
  summarizeWaitDurableCell,
  summarizeWaitExpiredCell,
  summarizeWaitMissingCell,
  summarizeWaitQueuedCell,
  summarizeWaitRetainedCell,
  summarizeWaitRunningCell,
  validateCellId,
} from './execute-code-cell-summary.js';
import {
  PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS,
  type PtcExecuteCodeCellDurableOutput,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeRuntimeWaitResult,
} from './execute-code-runtime-contract.js';

type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;

export async function waitForExecuteCodeCell(args: {
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  runContext: {
    threadId: string;
  };
  readDurableOutput?: (args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }) => Promise<
    | { ok: true; value: PtcExecuteCodeCellDurableOutput | undefined }
    | { ok: false; message: string }
  >;
  request: {
    cellId: string;
    terminate?: boolean;
    yieldTimeMs?: number;
  };
  signal: AbortSignal | undefined;
}): Promise<PtcExecuteCodeRuntimeWaitResult> {
  const request = validateCellWaitRequest(args.request);
  if (!request.ok) {
    return request;
  }
  const cellId = request.value.cellId;
  const waitStartedAtMs = Date.now();

  for (;;) {
    const retainedDurableOutput =
      args.cellRegistry.readTerminalCellDurableOutput({
        threadId: args.runContext.threadId,
        cellId,
      });
    const completed = args.cellRegistry.takeTerminalCellResult({
      threadId: args.runContext.threadId,
      cellId,
    });
    if (completed.ok) {
      if (
        retainedDurableOutput !== undefined &&
        args.readDurableOutput !== undefined
      ) {
        return {
          ok: true,
          value: summarizeWaitDurableCell({
            cellId,
            durableOutput: retainedDurableOutput,
          }),
        };
      }
      return summarizeWaitRetainedCell({ cellId, result: completed.value });
    }
    if (completed.reasonCode === 'cell_expired') {
      return await recoverDurableTerminalResult({
        cellId,
        fallback: 'expired',
        readDurableOutput: args.readDurableOutput,
        threadId: args.runContext.threadId,
        ...(retainedDurableOutput === undefined
          ? {}
          : { retainedDurableOutput }),
      });
    }

    if (args.request.terminate === true) {
      const closed = await args.cellRegistry.closeCell({
        threadId: args.runContext.threadId,
        cellId,
        reason: 'terminate',
      });
      if (closed.ok && closed.status === 'terminated') {
        if (!isProvenTerminatedCellCleanup(closed)) {
          return cellCleanupFailure({
            message: 'PTC execute_code cell cleanup failed',
            diagnostics: cellCloseDiagnostics(closed),
            ...(closed.store === undefined ? {} : { store: closed.store }),
          });
        }
        return {
          ok: true,
          value: summarizeWaitClosedCell({
            cellId,
            output: closed.output,
            exit: closed.exit,
            ...(closed.store === undefined ? {} : { store: closed.store }),
          }),
        };
      }
      if (closed.ok && closed.status === 'terminal_retained_dropped') {
        return summarizeWaitRetainedCell({
          cellId,
          result: closed.terminalResult,
        });
      }
      if (closed.ok && closed.status === 'terminal_expired_dropped') {
        return await recoverDurableTerminalResult({
          cellId,
          fallback: 'expired',
          readDurableOutput: args.readDurableOutput,
          threadId: args.runContext.threadId,
        });
      }
      if (closed.ok && closed.status === 'queued_cancelled') {
        return {
          ok: true,
          value: summarizeWaitClosedCell({
            cellId,
            output: undefined,
            exit: undefined,
            ...(closed.store === undefined ? {} : { store: closed.store }),
          }),
        };
      }
      return await recoverDurableTerminalResult({
        cellId,
        fallback: 'missing',
        readDurableOutput: args.readDurableOutput,
        threadId: args.runContext.threadId,
      });
    }

    const observedThreadRevision = args.cellRegistry.getThreadRevision({
      threadId: args.runContext.threadId,
    });
    const state = args.cellRegistry.readCellState({
      threadId: args.runContext.threadId,
      cellId,
    });
    if (state?.state === 'queued') {
      const yieldTimeMs = getRemainingYieldTimeMs({
        requestedYieldTimeMs: request.value.yieldTimeMs,
        waitStartedAtMs,
      });
      if (yieldTimeMs === 0) {
        return { ok: true, value: summarizeWaitQueuedCell(cellId) };
      }
      const wait = await waitForQueuedCellObservationWindow({
        afterThreadRevision: observedThreadRevision,
        cellRegistry: args.cellRegistry,
        signal: args.signal,
        threadId: args.runContext.threadId,
        ...(yieldTimeMs === undefined ? {} : { yieldTimeMs }),
      });
      if (wait.kind === 'abort') {
        return {
          ok: false,
          reasonCode: 'ptc_execute_code_cell_wait_cancelled',
          message: 'PTC execute_code cell wait was cancelled',
        };
      }
      if (wait.kind === 'timeout') {
        return { ok: true, value: summarizeWaitQueuedCell(cellId) };
      }
      continue;
    }
    if (state?.state !== 'running') {
      return await recoverDurableTerminalResult({
        cellId,
        fallback: state?.state === 'terminal_expired' ? 'expired' : 'missing',
        readDurableOutput: args.readDurableOutput,
        threadId: args.runContext.threadId,
      });
    }

    const effectiveTimeout =
      args.cellRegistry.readRunningCellEffectiveTimeoutMs({
        threadId: args.runContext.threadId,
        cellId,
      });
    if (!effectiveTimeout.ok) {
      return await recoverDurableTerminalResult({
        cellId,
        fallback: 'missing',
        readDurableOutput: args.readDurableOutput,
        threadId: args.runContext.threadId,
      });
    }
    if (
      request.value.yieldTimeMs !== undefined &&
      request.value.yieldTimeMs > effectiveTimeout.value.effectiveTimeoutMs
    ) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message:
          'PTC execute_code cell wait yieldTimeMs exceeds the cell execution timeout',
      };
    }

    const outputRevision = args.cellRegistry.readRunningCellOutputRevision({
      threadId: args.runContext.threadId,
      cellId,
    });
    if (!outputRevision.ok) {
      return await recoverDurableTerminalResult({
        cellId,
        fallback: 'missing',
        readDurableOutput: args.readDurableOutput,
        threadId: args.runContext.threadId,
      });
    }

    const output = args.cellRegistry.drainRunningCellOutput({
      threadId: args.runContext.threadId,
      cellId,
    });
    if (!output.ok) {
      continue;
    }
    if (hasCellOutput(output.value)) {
      return {
        ok: true,
        value: summarizeWaitRunningCell({ cellId, output: output.value }),
      };
    }

    const yieldTimeMs = getRemainingYieldTimeMs({
      requestedYieldTimeMs: request.value.yieldTimeMs,
      waitStartedAtMs,
    });
    if (yieldTimeMs === 0) {
      return {
        ok: true,
        value: summarizeWaitRunningCell({ cellId, output: output.value }),
      };
    }

    const wait = await waitForCellObservationWindow({
      afterOutputRevision: outputRevision.value.outputRevision,
      afterThreadRevision: args.cellRegistry.getThreadRevision({
        threadId: args.runContext.threadId,
      }),
      cellId,
      cellRegistry: args.cellRegistry,
      signal: args.signal,
      threadId: args.runContext.threadId,
      ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
    });
    if (wait.kind === 'abort') {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_cell_wait_cancelled',
        message: 'PTC execute_code cell wait was cancelled',
      };
    }
  }
}

async function recoverDurableTerminalResult(args: {
  cellId: PtcExecuteCodeCellId;
  fallback: 'expired' | 'missing';
  readDurableOutput:
    | ((args: {
        threadId: string;
        cellId: PtcExecuteCodeCellId;
      }) => Promise<
        | { ok: true; value: PtcExecuteCodeCellDurableOutput | undefined }
        | { ok: false; message: string }
      >)
    | undefined;
  retainedDurableOutput?: PtcExecuteCodeCellDurableOutput;
  threadId: string;
}): Promise<PtcExecuteCodeRuntimeWaitResult> {
  if (args.readDurableOutput === undefined) {
    return {
      ok: true,
      value:
        args.fallback === 'expired'
          ? summarizeWaitExpiredCell(args.cellId)
          : summarizeWaitMissingCell(args.cellId),
    };
  }
  const durableOutput =
    args.retainedDurableOutput === undefined
      ? await args.readDurableOutput({
          threadId: args.threadId,
          cellId: args.cellId,
        })
      : { ok: true as const, value: args.retainedDurableOutput };
  if (durableOutput?.ok === false) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_cell_wait_unavailable',
      message: durableOutput.message,
    };
  }
  if (durableOutput?.value !== undefined) {
    return {
      ok: true,
      value: summarizeWaitDurableCell({
        cellId: args.cellId,
        durableOutput: durableOutput.value,
      }),
    };
  }
  return {
    ok: true,
    value:
      args.fallback === 'expired'
        ? summarizeWaitExpiredCell(args.cellId)
        : summarizeWaitMissingCell(args.cellId),
  };
}

async function waitForQueuedCellObservationWindow(args: {
  afterThreadRevision: number;
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  signal: AbortSignal | undefined;
  threadId: string;
  yieldTimeMs?: number;
}): Promise<{ kind: 'change' | 'timeout' | 'abort' }> {
  if (args.signal?.aborted === true) {
    return { kind: 'abort' };
  }

  const waitAbort = new AbortController();
  return await new Promise((resolve) => {
    let settled = false;
    const timer =
      args.yieldTimeMs === undefined
        ? undefined
        : setTimeout(() => finish({ kind: 'timeout' }), args.yieldTimeMs);
    timer?.unref?.();

    const finish = (result: { kind: 'change' | 'timeout' | 'abort' }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      waitAbort.abort();
      args.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ kind: 'abort' });

    args.signal?.addEventListener('abort', onAbort, { once: true });
    void args.cellRegistry
      .waitForThreadRevisionChange({
        threadId: args.threadId,
        afterRevision: args.afterThreadRevision,
        abortSignal: waitAbort.signal,
      })
      .then(
        () => finish({ kind: 'change' }),
        () => undefined,
      );
  });
}

function validateCellWaitRequest(request: {
  cellId: string;
  terminate?: boolean;
  yieldTimeMs?: number;
}):
  | {
      ok: true;
      value: {
        cellId: PtcExecuteCodeCellId;
        terminate?: boolean;
        yieldTimeMs?: number;
      };
    }
  | Extract<PtcExecuteCodeRuntimeWaitResult, { ok: false }> {
  const cellId = validateCellId(request.cellId);
  if (cellId === undefined) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code cell id is invalid',
    };
  }

  if (
    request.yieldTimeMs !== undefined &&
    (!Number.isInteger(request.yieldTimeMs) ||
      request.yieldTimeMs < PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS ||
      request.yieldTimeMs > PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS)
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code cell wait yieldTimeMs is invalid',
    };
  }

  return {
    ok: true,
    value: {
      cellId,
      ...(request.terminate !== undefined
        ? { terminate: request.terminate }
        : {}),
      ...(request.yieldTimeMs !== undefined
        ? { yieldTimeMs: request.yieldTimeMs }
        : {}),
    },
  };
}

async function waitForCellObservationWindow(args: {
  afterOutputRevision: number;
  afterThreadRevision: number;
  cellId: PtcExecuteCodeCellId;
  cellRegistry: ReturnType<CreatePtcExecuteCodeCellRegistry>;
  signal: AbortSignal | undefined;
  threadId: string;
  yieldTimeMs?: number;
}): Promise<{ kind: 'change' | 'timeout' | 'abort' }> {
  if (args.signal?.aborted === true) {
    return { kind: 'abort' };
  }

  const waitAbort = new AbortController();
  return await new Promise((resolve) => {
    let settled = false;
    const timer =
      args.yieldTimeMs === undefined
        ? undefined
        : setTimeout(() => {
            finish({ kind: 'timeout' });
          }, args.yieldTimeMs);
    timer?.unref?.();

    const finish = (result: { kind: 'change' | 'timeout' | 'abort' }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      waitAbort.abort();
      args.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      finish({ kind: 'abort' });
    };

    args.signal?.addEventListener('abort', onAbort, { once: true });
    void args.cellRegistry
      .waitForThreadRevisionChange({
        threadId: args.threadId,
        afterRevision: args.afterThreadRevision,
        abortSignal: waitAbort.signal,
      })
      .then(
        () => finish({ kind: 'change' }),
        () => undefined,
      );
    void args.cellRegistry
      .waitForRunningCellOutputChange({
        threadId: args.threadId,
        cellId: args.cellId,
        afterOutputRevision: args.afterOutputRevision,
        abortSignal: waitAbort.signal,
      })
      .then(
        () => finish({ kind: 'change' }),
        () => undefined,
      );
  });
}

function getRemainingYieldTimeMs(args: {
  requestedYieldTimeMs: number | undefined;
  waitStartedAtMs: number;
}): number | undefined {
  if (args.requestedYieldTimeMs === undefined) {
    return undefined;
  }
  return Math.max(
    0,
    args.requestedYieldTimeMs - (Date.now() - args.waitStartedAtMs),
  );
}

function hasCellOutput(output: { stdout: string; stderr: string }): boolean {
  return output.stdout.length > 0 || output.stderr.length > 0;
}
