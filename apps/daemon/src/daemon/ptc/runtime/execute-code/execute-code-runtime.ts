import { admitPtcBoundedTimeoutMs } from '../../shared/lab-spine.js';
import { definedPtcProps } from '../../shared/record-shape.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerBatchCommandPolicyProjection,
} from '../../lab/profile/lab-profile.js';
import { createPtcLabSessionBatchCommandRunner } from '../../lab/shell/lab-session-batch-command.js';
import {
  resolvePtcSessionEpochBridgeCallbackPolicyFromEnv,
  type createPtcSessionEpochBridge,
  type PtcSessionEpochBridgeCallbackPolicy,
} from '../../callback/session-epoch-bridge.js';
import { createPtcSessionDockerManager } from '../../lab/session/session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';
import {
  buildNodeExecuteCodeCommand,
  closeCallbackBridge,
  createExecuteCodeCallbackRuntime,
  maybeCreateCallbackBridge,
  runExecuteCodeRuntimeAttempt,
  summarizeExecution,
  type ValidatedExecuteCodeRequest,
} from './execute-code-batch-runtime.js';
import {
  createPtcExecuteCodeWarmSessionPlacementCoordinator,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
} from './execute-code-placement.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import {
  runExecuteCodeCellRuntimeAttempt,
  type StartPtcExecuteCodeCellProcess,
} from './execute-code-cell-runtime.js';
import { waitForExecuteCodeCell } from './execute-code-cell-wait.js';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeRuntime,
  type PtcExecuteCodeRuntimeCleanupResult,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeWaitResult,
} from './execute-code-runtime-contract.js';
import {
  resolvePtcCanonicalWorkspaceRoot,
  resolvePtcRuntimeRoot,
} from '../runtime-workspace.js';

type CreatePtcSessionDockerManager = typeof createPtcSessionDockerManager;
type CreatePtcLabSessionBatchCommandRunner =
  typeof createPtcLabSessionBatchCommandRunner;
type CreatePtcSessionEpochBridge = typeof createPtcSessionEpochBridge;
type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;
type CreatePtcExecuteCodePlacementCoordinator =
  typeof createPtcExecuteCodeWarmSessionPlacementCoordinator;

type ExecuteCodeRuntimeRunArgs = Parameters<
  PtcExecuteCodeRuntime['executeCode']
>[0];

interface PtcExecuteCodeCellInvocationResultEntry {
  result: Promise<PtcExecuteCodeRuntimeResult>;
  threadId: string;
  cellId?: PtcExecuteCodeCellId;
}

export const PTC_EXECUTE_CODE_CELL_ENABLED_ENV =
  'GEULBAT_PTC_CELL_ENABLED' as const;
export const PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV =
  'GEULBAT_PTC_CELL_INITIAL_YIELD_MS' as const;
export const PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV =
  'GEULBAT_PTC_CELL_RUNNING_REAP_MS' as const;

type PtcExecuteCodeCellEnv = Readonly<
  Partial<
    Record<
      | typeof PTC_EXECUTE_CODE_CELL_ENABLED_ENV
      | typeof PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV
      | typeof PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV,
      string | undefined
    >
  >
>;

type PtcExecuteCodeCellRuntimeConfig =
  | { enabled?: false }
  | {
      enabled: true;
      initialYieldTimeMs: number;
      runningCellReapAfterMs: number;
    };

export interface CreatePtcExecuteCodeRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  createBatchCommandRunner?: CreatePtcLabSessionBatchCommandRunner;
  createPlacementCoordinator?: CreatePtcExecuteCodePlacementCoordinator;
  getPlacementContinuityProvenance?: PtcExecuteCodePlacementContinuityProvenanceProvider;
  createEpochBridge?: CreatePtcSessionEpochBridge;
  createCellRegistry?: CreatePtcExecuteCodeCellRegistry;
  startCellProcess?: StartPtcExecuteCodeCellProcess;
  callbackTransportPolicy?: PtcSessionEpochBridgeCallbackPolicy;
  ptcCell?: PtcExecuteCodeCellRuntimeConfig;
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
  trustContextId?: string;
}

export function resolvePtcExecuteCodeCellRuntimeConfigFromEnv(
  env: PtcExecuteCodeCellEnv = process.env,
): PtcExecuteCodeCellRuntimeConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV];
  const initialYieldRaw = env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV];
  const runningReapRaw = env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV];
  if (enabledRaw === undefined) {
    if (initialYieldRaw !== undefined || runningReapRaw !== undefined) {
      throw new Error(
        `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
      );
    }
    return undefined;
  }

  const enabled = readPtcCellBooleanEnv(
    PTC_EXECUTE_CODE_CELL_ENABLED_ENV,
    enabledRaw,
  );
  if (enabled && initialYieldRaw === undefined) {
    throw new Error(
      `${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    );
  }
  if (enabled && runningReapRaw === undefined) {
    throw new Error(
      `${PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    );
  }
  if (!enabled) {
    if (initialYieldRaw !== undefined || runningReapRaw !== undefined) {
      throw new Error(
        `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
      );
    }
    return Object.freeze({ enabled: false });
  }

  if (initialYieldRaw !== undefined && runningReapRaw !== undefined) {
    return Object.freeze({
      enabled: true,
      initialYieldTimeMs: readPtcCellIntegerEnv(
        PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV,
        initialYieldRaw,
      ),
      runningCellReapAfterMs: readPtcCellIntegerEnv(
        PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV,
        runningReapRaw,
      ),
    });
  }
  throw new Error(
    `${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
  );
}

export function resolvePtcExecuteCodeCallbackTransportPolicyFromEnv(
  env: Parameters<
    typeof resolvePtcSessionEpochBridgeCallbackPolicyFromEnv
  >[0] = process.env,
): PtcSessionEpochBridgeCallbackPolicy | undefined {
  return resolvePtcSessionEpochBridgeCallbackPolicyFromEnv(env);
}

interface ExecuteCodeWorkspaceRuntime {
  canonicalWorkspaceRoot: string;
  sessionManager: PtcSessionDockerManager;
  batchRunner: ReturnType<CreatePtcLabSessionBatchCommandRunner>;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
}

function readPtcCellBooleanEnv(name: string, raw: string): boolean {
  const value = raw.trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`invalid ${name}: ${value || 'empty'}`);
}

function readPtcCellIntegerEnv(name: string, raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function hasExplicitPtcExecuteCodeCallbackTransportPolicy(
  options: CreatePtcExecuteCodeRuntimeOptions,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    options,
    'callbackTransportPolicy',
  );
}

export function createPtcExecuteCodeRuntime(
  options: CreatePtcExecuteCodeRuntimeOptions = {},
): PtcExecuteCodeRuntime {
  if (
    options.ptcCell?.enabled === true &&
    (!Number.isSafeInteger(options.ptcCell.initialYieldTimeMs) ||
      options.ptcCell.initialYieldTimeMs < 1)
  ) {
    throw new Error(
      'PTC execute_code cell initialYieldTimeMs is required when ptcCell.enabled is true',
    );
  }
  if (
    options.ptcCell?.enabled === true &&
    (!Number.isSafeInteger(options.ptcCell.runningCellReapAfterMs) ||
      options.ptcCell.runningCellReapAfterMs < 1)
  ) {
    throw new Error(
      'PTC execute_code cell runningCellReapAfterMs is required when ptcCell.enabled is true',
    );
  }
  const ptcCellConfig =
    options.ptcCell?.enabled === true ? options.ptcCell : undefined;
  const callbackTransportPolicy =
    hasExplicitPtcExecuteCodeCallbackTransportPolicy(options)
      ? options.callbackTransportPolicy
      : resolvePtcExecuteCodeCallbackTransportPolicyFromEnv();
  const workspaceRuntimes = new Map<string, ExecuteCodeWorkspaceRuntime>();
  const cellRegistry =
    ptcCellConfig !== undefined
      ? (options.createCellRegistry ?? createPtcExecuteCodeCellRegistry)({
          runningCellReapAfterMs: ptcCellConfig.runningCellReapAfterMs,
        })
      : undefined;
  const cellInvocationResultsByKey = new Map<
    string,
    PtcExecuteCodeCellInvocationResultEntry
  >();

  function deleteCellInvocationResultsForThreadCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    entry?: PtcExecuteCodeCellInvocationResultEntry;
  }): void {
    for (const [key, entry] of cellInvocationResultsByKey) {
      if (
        entry.threadId === args.threadId &&
        (args.entry === undefined
          ? entry.cellId === args.cellId
          : entry === args.entry)
      ) {
        cellInvocationResultsByKey.delete(key);
      }
    }
  }

  async function getWorkspaceRuntime(workspaceRoot: string): Promise<
    | { ok: true; value: ExecuteCodeWorkspaceRuntime }
    | {
        ok: false;
        reasonCode: 'ptc_lab_session_unavailable';
        message: string;
        diagnostics: Record<string, string | number | boolean>;
      }
  > {
    let canonicalWorkspaceRoot: string;
    try {
      canonicalWorkspaceRoot = await resolvePtcCanonicalWorkspaceRoot({
        workspaceRoot,
        realpathWorkspaceRoot: options.realpathWorkspaceRoot,
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC execute_code workspace root is unavailable',
        diagnostics: { workspaceRootRealpathFailed: true },
      };
    }

    const current = workspaceRuntimes.get(canonicalWorkspaceRoot);
    if (current !== undefined) {
      return { ok: true, value: current };
    }

    const runtimeRoot = resolvePtcRuntimeRoot({
      workspaceRoot: canonicalWorkspaceRoot,
      runtimeRootForWorkspace: options.runtimeRootForWorkspace,
      runtimeLabel: 'execute_code',
    });

    const createSessionManager =
      options.createSessionManager ?? createPtcSessionDockerManager;
    const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
      runtimeRoot,
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      realpathWorkspaceRoot: async () => canonicalWorkspaceRoot,
      ...definedPtcProps({
        dockerPath: options.dockerPath,
        commandRunner: options.commandRunner,
      }),
    };

    const sessionManager = createSessionManager(managerArgs);
    const createBatchCommandRunner =
      options.createBatchCommandRunner ?? createPtcLabSessionBatchCommandRunner;
    const createPlacementCoordinator =
      options.createPlacementCoordinator ??
      createPtcExecuteCodeWarmSessionPlacementCoordinator;
    const runtime = {
      canonicalWorkspaceRoot,
      sessionManager,
      batchRunner: createBatchCommandRunner({ sessionManager }),
      placementCoordinator: createPlacementCoordinator(),
    };
    workspaceRuntimes.set(canonicalWorkspaceRoot, runtime);
    return { ok: true, value: runtime };
  }

  return {
    async executeCode(
      args: ExecuteCodeRuntimeRunArgs,
    ): Promise<PtcExecuteCodeRuntimeResult> {
      const labPolicy = createPtcLabLocalDockerBatchCommandPolicyProjection();
      const request = validateExecuteCodeRequest(args.request, {
        defaultTimeoutMs: labPolicy.shell.maxCommandMs,
        maxTimeoutMs: labPolicy.shell.maxCommandMs,
      });
      if (!request.ok) {
        return request;
      }

      const workspaceRuntimeResult = await getWorkspaceRuntime(
        args.runContext.workspaceRoot,
      );
      if (!workspaceRuntimeResult.ok) {
        return workspaceRuntimeResult;
      }
      const workspaceRuntime = workspaceRuntimeResult.value;

      const admission = admitPtcExecutionProfile({
        requestedProfile: 'lab',
        labEnabled: true,
        reason: 'workload_router',
        labPolicy,
      });
      if (!admission.ok) {
        return {
          ok: false,
          reasonCode: 'ptc_execute_code_lab_admission_failed',
          message: admission.message,
          diagnostics: { admissionReasonCode: admission.reasonCode },
        };
      }

      const identity: PtcSessionDockerIdentity = {
        threadId: args.runContext.threadId,
        workspaceRoot: workspaceRuntime.canonicalWorkspaceRoot,
        trustContextId:
          options.trustContextId ?? PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
      };
      const callbackRuntime = createExecuteCodeCallbackRuntime({
        callbackTransportPolicy,
        toolCallbackHandler: args.toolCallbackHandler,
      });
      const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
        callbacksEnabled: callbackRuntime.enabled,
        sdkHelp: args.sdkHelp,
      });

      if (ptcCellConfig !== undefined && cellRegistry !== undefined) {
        const runCellAttempt = (runtimeArgs?: {
          onRunningCellSettled?: Parameters<
            typeof runExecuteCodeCellRuntimeAttempt
          >[0]['onRunningCellSettled'];
        }) =>
          runExecuteCodeCellRuntimeAttempt({
            admission: admission.value,
            batchRunner: workspaceRuntime.batchRunner,
            buildCommand: buildNodeExecuteCodeCommand,
            callbackRuntime,
            cellRegistry,
            closeCallbackBridge,
            createEpochBridge: options.createEpochBridge,
            dockerPath: options.dockerPath,
            identity,
            initialYieldTimeMs:
              request.value.yieldTimeMs ??
              Math.min(
                ptcCellConfig.initialYieldTimeMs,
                request.value.timeoutMs,
              ),
            maybeCreateCallbackBridge,
            placementCoordinator: workspaceRuntime.placementCoordinator,
            getPlacementContinuityProvenance:
              options.getPlacementContinuityProvenance,
            placementResourceSnapshotRef: args.placementResourceSnapshotRef,
            ...definedPtcProps({
              onRunningCellSettled: runtimeArgs?.onRunningCellSettled,
            }),
            request: request.value,
            sdkHelpBundle,
            sessionManager: workspaceRuntime.sessionManager,
            signal: args.signal,
            startCellProcess: options.startCellProcess,
            summarizeCompletedExecution: summarizeExecution,
          });
        const invocationKey = buildPtcExecuteCodeInvocationKey({
          invocationId: args.invocationId,
          threadId: args.runContext.threadId,
        });
        if (invocationKey === undefined) {
          return await runCellAttempt();
        }

        const currentInvocationResult =
          cellInvocationResultsByKey.get(invocationKey);
        if (currentInvocationResult !== undefined) {
          if (currentInvocationResult.cellId !== undefined) {
            const cellState = cellRegistry.readCellState({
              threadId: args.runContext.threadId,
            });
            if (
              cellState?.cellId !== currentInvocationResult.cellId ||
              cellState.state !== 'running'
            ) {
              cellInvocationResultsByKey.delete(invocationKey);
            } else {
              return await currentInvocationResult.result;
            }
          } else {
            return await currentInvocationResult.result;
          }
        }

        let invocationEntry:
          | PtcExecuteCodeCellInvocationResultEntry
          | undefined;
        const invocationResult = runCellAttempt({
          onRunningCellSettled: ({ threadId, cellId }) => {
            if (invocationEntry === undefined) {
              return;
            }
            deleteCellInvocationResultsForThreadCell({
              threadId,
              cellId,
              entry: invocationEntry,
            });
          },
        });
        invocationEntry = {
          result: invocationResult,
          threadId: args.runContext.threadId,
        };
        cellInvocationResultsByKey.set(invocationKey, invocationEntry);
        try {
          const result = await invocationResult;
          if (
            result.ok &&
            result.value.executionSurface === 'node_via_lab_detached_cell' &&
            result.value.status === 'running'
          ) {
            invocationEntry.cellId = result.value.cellId;
          } else {
            cellInvocationResultsByKey.delete(invocationKey);
          }
          return result;
        } catch (err: unknown) {
          cellInvocationResultsByKey.delete(invocationKey);
          throw err;
        }
      }

      return await runExecuteCodeRuntimeAttempt({
        admission: admission.value,
        callbackRuntime,
        commandRunner: options.commandRunner,
        createEpochBridge: options.createEpochBridge,
        dockerPath: options.dockerPath,
        identity,
        placementCoordinator: workspaceRuntime.placementCoordinator,
        getPlacementContinuityProvenance:
          options.getPlacementContinuityProvenance,
        placementResourceSnapshotRef: args.placementResourceSnapshotRef,
        request: request.value,
        sdkHelpBundle,
        sessionManager: workspaceRuntime.sessionManager,
        batchRunner: workspaceRuntime.batchRunner,
        signal: args.signal,
      });
    },

    async waitForCell(args: {
      runContext: {
        threadId: string;
      };
      request: {
        cellId: string;
        terminate?: boolean;
        yieldTimeMs?: number;
      };
      signal?: AbortSignal;
    }): Promise<PtcExecuteCodeRuntimeWaitResult> {
      if (cellRegistry === undefined) {
        return {
          ok: false,
          reasonCode: 'ptc_execute_code_cell_wait_unavailable',
          message: 'PTC execute_code cell wait is not enabled',
        };
      }

      const result = await waitForExecuteCodeCell({
        cellRegistry,
        runContext: args.runContext,
        request: args.request,
        signal: args.signal,
      });
      if (
        result.ok &&
        result.value.executionSurface === 'node_via_lab_detached_cell' &&
        result.value.status !== 'running'
      ) {
        deleteCellInvocationResultsForThreadCell({
          threadId: args.runContext.threadId,
          cellId: result.value.cellId,
        });
      }
      return result;
    },

    async closeAll(args?: {
      signal?: AbortSignal;
    }): Promise<PtcExecuteCodeRuntimeCleanupResult> {
      await cellRegistry?.closeAllCells({ reason: 'shutdown' });
      cellInvocationResultsByKey.clear();
      let firstFailure: PtcExecuteCodeRuntimeCleanupResult | undefined;
      let workspaceRuntimeCount = 0;
      for (const runtime of workspaceRuntimes.values()) {
        workspaceRuntimeCount += 1;
        const cleanup = await runtime.sessionManager.closeAll(
          args?.signal === undefined ? undefined : { signal: args.signal },
        );
        if (!cleanup.ok && firstFailure === undefined) {
          firstFailure = {
            ok: false,
            reasonCode: 'ptc_execute_code_session_cleanup_failed',
            message: 'PTC execute_code session cleanup failed',
            diagnostics: {
              cleanupReasonCode: cleanup.reasonCode,
              workspaceRuntimeCount,
            },
          };
        }
      }
      workspaceRuntimes.clear();
      if (firstFailure !== undefined) {
        return firstFailure;
      }
      return { ok: true };
    },
  };
}

function validateExecuteCodeRequest(
  request: {
    code: string;
    timeoutMs?: number;
    yieldTimeMs?: number;
  },
  policy: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
  },
):
  | Extract<PtcExecuteCodeRuntimeResult, { ok: false }>
  | {
      ok: true;
      value: ValidatedExecuteCodeRequest;
    } {
  if (typeof request.code !== 'string' || request.code.trim().length === 0) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code input is invalid',
    };
  }

  const timeout = admitPtcBoundedTimeoutMs({
    timeoutMs: request.timeoutMs,
    defaultTimeoutMs: policy.defaultTimeoutMs,
    maxTimeoutMs: policy.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code timeout is invalid',
    };
  }

  if (
    request.yieldTimeMs !== undefined &&
    (!Number.isInteger(request.yieldTimeMs) ||
      request.yieldTimeMs < PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS ||
      request.yieldTimeMs > PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS)
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code cell yieldTimeMs is invalid',
    };
  }
  if (
    request.yieldTimeMs !== undefined &&
    request.yieldTimeMs > timeout.value
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message:
        'PTC execute_code cell yieldTimeMs exceeds the execution timeout',
    };
  }

  return {
    ok: true,
    value: {
      code: request.code,
      timeoutMs: timeout.value,
      ...(request.yieldTimeMs !== undefined
        ? { yieldTimeMs: request.yieldTimeMs }
        : {}),
    },
  };
}

function buildPtcExecuteCodeInvocationKey(args: {
  threadId: string;
  invocationId: string | undefined;
}): string | undefined {
  if (args.invocationId === undefined || args.invocationId.length === 0) {
    return undefined;
  }
  return `${args.threadId}\u0000${args.invocationId}`;
}
