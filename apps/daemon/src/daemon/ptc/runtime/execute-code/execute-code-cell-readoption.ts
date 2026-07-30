import type { PtcEpochCallbackHandler } from '../../callback/epoch-callback.js';
import type { PtcSessionDockerIdentity } from '../../lab/session/session-docker-contract.js';
import { PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS } from './execute-code-cell-registry.js';
import type { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { trackAdoptedRunningCellCompletion } from './execute-code-cell-settlement.js';
import type {
  AttachPtcExecuteCodeCellProcess,
  DetachedProcessHandle,
} from './execute-code-cell-process.js';
import type {
  PtcExecuteCodeCellCoordinate,
  PtcExecuteCodeCellCoordinateStore,
  PtcExecuteCodeCellId,
  PtcExecuteCodeRunningExecDelivery,
  PtcExecuteCodeRunningWaitDelivery,
  PtcExecuteCodeRuntimeCleanupResult,
} from './execute-code-runtime-contract.js';
import type { createPtcExecuteCodeRuntimeStateOwner } from './execute-code-runtime-owner.js';
import type { ExecuteCodeStateRuntime } from './execute-code-state-runtime.js';

export interface PtcExecuteCodeEpochCallbackController {
  replaceHandler(handler: PtcEpochCallbackHandler): void;
  close(): Promise<void>;
}

type PtcExecuteCodeCellRegistry = ReturnType<
  typeof createPtcExecuteCodeCellRegistry
>;
type GetPtcExecuteCodeStateRuntime = ReturnType<
  typeof createPtcExecuteCodeRuntimeStateOwner
>['getStateRuntime'];
type RunningExecDeliveryPayload = Omit<
  PtcExecuteCodeRunningExecDelivery,
  'threadId' | 'runId' | 'callId'
>;

interface CreatePtcExecuteCodeCellReadoptionLedgerOptions {
  attachCellProcess: AttachPtcExecuteCodeCellProcess | undefined;
  attachEpochCallbackController:
    | ((args: {
        outputRef: string;
        handler: PtcEpochCallbackHandler;
      }) => Promise<PtcExecuteCodeEpochCallbackController>)
    | undefined;
  cellRegistry: PtcExecuteCodeCellRegistry | undefined;
  getStateRuntime: GetPtcExecuteCodeStateRuntime;
}

function cellCoordinateKey(coordinate: {
  threadId: string;
  cellId: string;
}): string {
  return `${coordinate.threadId}\u0000${coordinate.cellId}`;
}

function sessionIdentityFromCoordinate(
  coordinate: PtcExecuteCodeCellCoordinate,
): PtcSessionDockerIdentity {
  return {
    threadId: coordinate.threadId,
    stateRoot: coordinate.stateRoot,
    trustContextId: coordinate.trustContextId,
    ...(coordinate.ephemeralBurstId === undefined
      ? {}
      : { ephemeralBurstId: coordinate.ephemeralBurstId }),
    ...(coordinate.sdkProjectionMount === undefined
      ? {}
      : {
          sdkProjectionMount: {
            ...coordinate.sdkProjectionMount,
          },
        }),
  };
}

export function createPtcExecuteCodeCellReadoptionLedger(
  options: CreatePtcExecuteCodeCellReadoptionLedgerOptions,
) {
  let coordinateStore: PtcExecuteCodeCellCoordinateStore | undefined;
  const adoptedCoordinatesByKey = new Map<
    string,
    PtcExecuteCodeCellCoordinate
  >();
  let readoptionPromise:
    | Promise<PtcExecuteCodeRuntimeCleanupResult>
    | undefined;

  const recoveringCallbackHandler: PtcEpochCallbackHandler = async () => ({
    ok: false,
    errorCode: 'ptc_callback_controller_recovering',
    message:
      'PTC execute_code callback delivery is unavailable until the cell is claimed through wait',
  });

  async function finalizeFailedReadoption(args: {
    coordinate: PtcExecuteCodeCellCoordinate;
    stateRuntime: ExecuteCodeStateRuntime;
    sessionAdopted: boolean;
    handle?: DetachedProcessHandle;
    callbackController?: PtcExecuteCodeEpochCallbackController;
    diagnostics: Record<string, string | number | boolean>;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult> {
    const cleanupDiagnostics: Record<string, string | number | boolean> = {
      ...args.diagnostics,
    };
    let cleanupProven = true;

    if (args.handle !== undefined) {
      try {
        args.handle.terminate({
          graceMs: PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
        });
        await args.handle.exit;
      } catch {
        cleanupProven = false;
        cleanupDiagnostics.cellProcessCleanupFailed = true;
      }
    }
    if (args.callbackController !== undefined) {
      try {
        await args.callbackController.close();
      } catch {
        cleanupProven = false;
        cleanupDiagnostics.callbackProcessCleanupFailed = true;
      }
    }
    if (args.sessionAdopted) {
      const sessionCleanup = await args.stateRuntime.sessionManager.close(
        sessionIdentityFromCoordinate(args.coordinate),
      );
      if (!sessionCleanup.ok) {
        cleanupProven = false;
        cleanupDiagnostics.sessionCloseFailed = true;
        cleanupDiagnostics.sessionReasonCode = sessionCleanup.reasonCode;
      }
    }
    try {
      coordinateStore?.deletePtcExecuteCodeCellCoordinate(
        args.coordinate.cellId,
      );
    } catch {
      cleanupProven = false;
      cleanupDiagnostics.cellCoordinateDeleteFailed = true;
    }

    if (!cleanupProven) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message:
          'PTC execute_code cell re-adoption failed and cleanup was incomplete',
        diagnostics: cleanupDiagnostics,
      };
    }

    if (options.cellRegistry !== undefined) {
      await options.cellRegistry.recordCellCleanupFailure({
        threadId: args.coordinate.threadId,
        cellId: args.coordinate.cellId,
        terminalResultStateRoot: args.coordinate.stateRoot,
        message: 'PTC execute_code running cell could not be re-adopted',
        diagnostics: cleanupDiagnostics,
      });
    }
    return { ok: true };
  }

  async function reAdoptPersistedRunningCells(): Promise<PtcExecuteCodeRuntimeCleanupResult> {
    const store = coordinateStore;
    if (store === undefined) {
      return { ok: true };
    }
    let coordinates: readonly PtcExecuteCodeCellCoordinate[];
    try {
      coordinates = store.listPtcExecuteCodeCellCoordinates();
    } catch {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code cell coordinates could not be read',
        diagnostics: { cellCoordinateListFailed: true },
      };
    }
    if (coordinates.length === 0) {
      return { ok: true };
    }
    const callbackProcessAttacherRequired = coordinates.some(
      (coordinate) => coordinate.callbackOutputRef !== undefined,
    );
    if (
      options.attachCellProcess === undefined ||
      (callbackProcessAttacherRequired &&
        options.attachEpochCallbackController === undefined)
    ) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message:
          'PTC execute_code cell re-adoption is unavailable for persisted cells',
        diagnostics: {
          cellProcessAttacherMissing: options.attachCellProcess === undefined,
          callbackProcessAttacherMissing:
            callbackProcessAttacherRequired &&
            options.attachEpochCallbackController === undefined,
        },
      };
    }

    for (const coordinate of coordinates) {
      const stateRuntimeResult = await options.getStateRuntime(
        coordinate.stateRoot,
      );
      if (!stateRuntimeResult.ok) {
        return {
          ok: false,
          reasonCode: 'ptc_execute_code_session_cleanup_failed',
          message:
            'PTC execute_code cell re-adoption could not open its persisted state',
          diagnostics: stateRuntimeResult.diagnostics,
        };
      }
      const stateRuntime = stateRuntimeResult.value;
      const diagnostics: Record<string, string | number | boolean> = {};

      let sessionAdopted = false;
      const sessionManager = stateRuntime.sessionManager;
      if (sessionManager.adoptExisting === undefined) {
        return {
          ok: false,
          reasonCode: 'ptc_execute_code_session_cleanup_failed',
          message: 'PTC execute_code session re-adoption is unavailable',
          diagnostics: { sessionAdopterMissing: true },
        };
      }
      const sessionIdentity = sessionIdentityFromCoordinate(coordinate);
      const adoptedSession = await sessionManager.adoptExisting(
        sessionIdentity,
        {
          containerId: coordinate.containerId,
        },
      );
      if (adoptedSession.ok) {
        sessionAdopted = true;
      } else {
        diagnostics.containerAdoptionFailed = true;
        diagnostics.sessionReasonCode = adoptedSession.reasonCode;
      }

      let handle: DetachedProcessHandle | undefined;
      try {
        const attached = await options.attachCellProcess({
          outputRef: coordinate.processOutputRef,
          outputBufferPolicy: {
            maxBufferedBytesPerStream: coordinate.maxBufferedBytesPerStream,
          },
          ...(coordinate.outputReadOffsets === undefined
            ? {}
            : { outputReadOffsets: coordinate.outputReadOffsets }),
        });
        if (attached.ok) {
          handle = attached.handle;
        } else {
          diagnostics.cellProcessAdoptionFailed = true;
        }
      } catch {
        diagnostics.cellProcessAdoptionFailed = true;
      }

      let callbackController: PtcExecuteCodeEpochCallbackController | undefined;
      if (coordinate.callbackOutputRef !== undefined) {
        const attachCallbackController = options.attachEpochCallbackController;
        if (attachCallbackController === undefined) {
          diagnostics.callbackProcessAdoptionFailed = true;
        } else {
          try {
            callbackController = await attachCallbackController({
              outputRef: coordinate.callbackOutputRef,
              handler: recoveringCallbackHandler,
            });
          } catch {
            diagnostics.callbackProcessAdoptionFailed = true;
          }
        }
      }

      if (options.cellRegistry === undefined) {
        diagnostics.cellRuntimeDisabled = true;
      }
      if (coordinate.storeCallbacksEnabled) {
        diagnostics.storeCallbackReadoptionUnsupported = true;
      }
      if (
        coordinate.callbackToolNames.length > 0 &&
        coordinate.callbackOutputRef === undefined
      ) {
        diagnostics.callbackCoordinateMissing = true;
      }

      if (
        !sessionAdopted ||
        handle === undefined ||
        options.cellRegistry === undefined ||
        coordinate.storeCallbacksEnabled ||
        (coordinate.callbackOutputRef !== undefined &&
          callbackController === undefined) ||
        (coordinate.callbackToolNames.length > 0 &&
          coordinate.callbackOutputRef === undefined)
      ) {
        const finalized = await finalizeFailedReadoption({
          coordinate,
          stateRuntime,
          sessionAdopted,
          ...(handle === undefined ? {} : { handle }),
          ...(callbackController === undefined ? {} : { callbackController }),
          diagnostics,
        });
        if (!finalized.ok) {
          return finalized;
        }
        continue;
      }

      const adoptedCell = options.cellRegistry.adoptRunningCell({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
        createdAtMs: coordinate.createdAtMs,
        ...(coordinate.orphanReapAtMs === undefined
          ? {}
          : { orphanReapAtMs: coordinate.orphanReapAtMs }),
        resources: {
          effectiveTimeoutMs: coordinate.effectiveTimeoutMs,
          handle,
          closeBridge:
            callbackController === undefined
              ? () => undefined
              : () => callbackController.close(),
          ...(callbackController === undefined
            ? {}
            : {
                replaceCallbackHandler: (handler) =>
                  callbackController.replaceHandler(handler),
              }),
          taintSession: async () => {
            const closed =
              await stateRuntime.sessionManager.close(sessionIdentity);
            return closed.ok;
          },
          finalizeCoordinate: () => {
            store.deletePtcExecuteCodeCellCoordinate(coordinate.cellId);
            adoptedCoordinatesByKey.delete(cellCoordinateKey(coordinate));
          },
          terminalResultStateRoot: coordinate.stateRoot,
        },
      });
      if (!adoptedCell.ok) {
        const finalized = await finalizeFailedReadoption({
          coordinate,
          stateRuntime,
          sessionAdopted: true,
          handle,
          ...(callbackController === undefined ? {} : { callbackController }),
          diagnostics: { cellRegistryAdoptionFailed: true },
        });
        if (!finalized.ok) {
          return finalized;
        }
        continue;
      }

      adoptedCoordinatesByKey.set(cellCoordinateKey(coordinate), coordinate);
      trackAdoptedRunningCellCompletion({
        cellRegistry: options.cellRegistry,
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
        handle,
        onSettled: () => {
          adoptedCoordinatesByKey.delete(cellCoordinateKey(coordinate));
        },
      });
    }
    return { ok: true };
  }

  return {
    attachStore(store: PtcExecuteCodeCellCoordinateStore): void {
      if (coordinateStore !== undefined && coordinateStore !== store) {
        throw new Error(
          'PTC execute_code cell coordinate store is already attached',
        );
      }
      coordinateStore = store;
    },

    async reAdoptRunningCells(): Promise<PtcExecuteCodeRuntimeCleanupResult> {
      readoptionPromise ??= reAdoptPersistedRunningCells();
      return await readoptionPromise;
    },

    getAdoptedCoordinate(args: {
      threadId: string;
      cellId: string;
    }): PtcExecuteCodeCellCoordinate | undefined {
      return adoptedCoordinatesByKey.get(cellCoordinateKey(args));
    },

    getAdoptedRunningCellCount(): number {
      return adoptedCoordinatesByKey.size;
    },

    supportsRunningExecDelivery(): boolean {
      return (
        coordinateStore?.readPtcExecuteCodeRunningExecDelivery !== undefined &&
        coordinateStore.persistPtcExecuteCodeRunningExecDelivery !== undefined
      );
    },

    readRunningExecDelivery(args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }): PtcExecuteCodeRunningExecDelivery | undefined {
      const store = coordinateStore;
      if (store?.readPtcExecuteCodeRunningExecDelivery === undefined) {
        throw new Error(
          'PTC execute_code running exec delivery store is unavailable',
        );
      }
      return store.readPtcExecuteCodeRunningExecDelivery(args);
    },

    persistRunningExecDelivery(
      delivery: PtcExecuteCodeRunningExecDelivery,
    ): void {
      const store = coordinateStore;
      if (store?.persistPtcExecuteCodeRunningExecDelivery === undefined) {
        throw new Error(
          'PTC execute_code running exec delivery store is unavailable',
        );
      }
      store.persistPtcExecuteCodeRunningExecDelivery(delivery);
    },

    deleteRunningExecDelivery(args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }): void {
      coordinateStore?.deletePtcExecuteCodeRunningExecDelivery?.(args);
    },

    readRunningWaitDelivery(args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }): PtcExecuteCodeRunningWaitDelivery | undefined {
      return coordinateStore?.readPtcExecuteCodeRunningWaitDelivery?.(args);
    },

    persistRunningWaitDelivery(
      delivery: PtcExecuteCodeRunningWaitDelivery,
    ): void {
      const store = coordinateStore;
      if (store?.persistPtcExecuteCodeRunningWaitDelivery === undefined) {
        throw new Error('PTC running wait delivery store is unavailable');
      }
      store.persistPtcExecuteCodeRunningWaitDelivery(delivery);
    },

    deleteRunningWaitDelivery(args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }): void {
      coordinateStore?.deletePtcExecuteCodeRunningWaitDelivery?.(args);
    },

    createRunningCellPersistence(args: {
      threadId: string;
      invocation:
        | {
            runId: string;
            callId: string;
          }
        | undefined;
      runningCellReapAfterMs: number;
    }):
      | {
          persistCellCoordinate(
            coordinate: PtcExecuteCodeCellCoordinate,
          ): Promise<void> | void;
          persistRunningExecDelivery?(
            delivery: RunningExecDeliveryPayload,
          ): void;
          deleteCellCoordinate(args: {
            threadId: string;
            cellId: PtcExecuteCodeCellId;
          }): void;
          runningCellReapAfterMs: number;
        }
      | undefined {
      const store = coordinateStore;
      if (store === undefined) {
        return undefined;
      }
      const invocation = args.invocation;
      return {
        persistCellCoordinate: (coordinate) =>
          store.persistPtcExecuteCodeCellCoordinate(coordinate),
        ...(invocation === undefined
          ? {}
          : {
              persistRunningExecDelivery: (
                delivery: RunningExecDeliveryPayload,
              ) =>
                store.persistPtcExecuteCodeRunningExecDelivery?.({
                  threadId: args.threadId,
                  runId: invocation.runId,
                  callId: invocation.callId,
                  ...delivery,
                }),
            }),
        deleteCellCoordinate: ({ cellId }) =>
          store.deletePtcExecuteCodeCellCoordinate(cellId),
        runningCellReapAfterMs: args.runningCellReapAfterMs,
      };
    },
  };
}
