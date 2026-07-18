import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import { admitPtcBoundedTimeoutMs } from '../../shared/lab-spine.js';
import { createPtcLogger } from '../../shared/logger.js';
import { definedPtcProps } from '../../shared/record-shape.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerBatchCommandPolicyProjection,
  createPtcLabLocalDockerOpenNetworkPackageInstallPolicyProjection,
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
  createPtcSessionDockerOpenNetworkPackageInstallPolicy,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  resolvePtcSessionDockerResourceRequirements,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import {
  resolvePtcExecuteCodePackageInstallConfigFromEnv,
  type PtcExecuteCodePackageInstallRuntimeConfig,
} from './execute-code-package-install-config.js';

export { resolvePtcExecuteCodePackageInstallConfigFromEnv } from './execute-code-package-install-config.js';
export { resolvePtcExecuteCodeStoreConfigFromEnv } from './execute-code-store.js';
import { runPtcExecuteCodePackageInstall } from './execute-code-package-install.js';
import {
  buildPtcExecuteCodeSdkHelpBundle,
  PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER,
} from './execute-code-sdk.js';
import {
  buildNodeExecuteCodeCommand,
  closeCallbackBridge,
  createExecuteCodeCallbackRuntime,
  createExecuteCodeStoreCallbackHandler,
  maybeCreateCallbackBridge,
  runExecuteCodeRuntimeAttempt,
  summarizeExecution,
  type ValidatedExecuteCodeRequest,
} from './execute-code-batch-runtime.js';
import {
  createPtcExecuteCodeStore,
  resolvePtcExecuteCodeStoreConfigFromEnv,
  type PtcExecuteCodeStore,
  type PtcExecuteCodeStoreExecution,
  type PtcExecuteCodeStoreRuntimeConfig,
} from './execute-code-store.js';
import {
  createPtcExecuteCodePlacementCoordinator,
  resolvePtcExecuteCodeBurstPlacementConfigFromEnv,
  type PtcExecuteCodeBurstPlacementConfig,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
} from './execute-code-placement.js';
import {
  createPtcExecuteCodeStandbyPool,
  resolvePtcExecuteCodeStandbyPlacementConfigFromEnv,
  type PtcExecuteCodeStandbyPlacementConfig,
} from './execute-code-standby-pool.js';
import {
  createPtcExecuteCodeCellRegistry,
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS,
  type PtcExecuteCodeCellRetainedResult,
} from './execute-code-cell-registry.js';
import {
  runExecuteCodeCellRuntimeAttempt,
  type StartPtcExecuteCodeCellProcess,
} from './execute-code-cell-runtime.js';
import { waitForExecuteCodeCell } from './execute-code-cell-wait.js';
import { summarizeWaitRetainedCell } from './execute-code-cell-summary.js';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
  stringifyPtcExecuteCodeWaitSummary,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeCellTerminalResultStore,
  type PtcExecuteCodePlacementResourceBudget,
  type PtcExecuteCodeRuntimeCellTerminalStatus,
  type PtcExecuteCodeRuntime,
  type PtcExecuteCodeRuntimeCleanupResult,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSdkProjection,
  type PtcExecuteCodeRuntimeWaitResult,
  type PtcPackageInstallRuntime,
  type PtcPackageInstallRuntimeResult,
} from './execute-code-runtime-contract.js';
import {
  resolvePtcCanonicalStateRoot,
  resolvePtcRuntimeRoot,
} from '../runtime-state.js';

const logger = createPtcLogger('execute-code/runtime');

type CreatePtcSessionDockerManager = typeof createPtcSessionDockerManager;
type CreatePtcLabSessionBatchCommandRunner =
  typeof createPtcLabSessionBatchCommandRunner;
type CreatePtcSessionEpochBridge = typeof createPtcSessionEpochBridge;
type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;
type CreatePtcExecuteCodePlacementCoordinator =
  typeof createPtcExecuteCodePlacementCoordinator;
type CreatePtcExecuteCodeStandbyPool = typeof createPtcExecuteCodeStandbyPool;

type ExecuteCodeRuntimeRunArgs = Parameters<
  PtcExecuteCodeRuntime['executeCode']
>[0];

interface PtcExecuteCodeCellInvocationResultEntry {
  result: Promise<PtcExecuteCodeRuntimeResult>;
  threadId: string;
  cellId?: PtcExecuteCodeCellId;
}

// Cell states that still hold the shared session (unsettled), so a package
// install must not race the running cell's npm reads/writes.
const PTC_EXECUTE_CODE_ACTIVE_CELL_STATES: ReadonlySet<string> = new Set([
  'admitting',
  'queued',
  'running',
  'terminating',
]);

export function isPtcExecuteCodeCellStateActive(state: string): boolean {
  return PTC_EXECUTE_CODE_ACTIVE_CELL_STATES.has(state);
}

export const PTC_EXECUTE_CODE_CELL_ENABLED_ENV =
  'GEULBAT_PTC_CELL_ENABLED' as const;
export const PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV =
  'GEULBAT_PTC_CELL_INITIAL_YIELD_MS' as const;
export const PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV =
  'GEULBAT_PTC_CELL_RUNNING_REAP_MS' as const;
export const PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV =
  'GEULBAT_PTC_CELL_TERMINAL_MEMORY_RETENTION_MS' as const;

type PtcExecuteCodeCellEnv = Readonly<
  Partial<
    Record<
      | typeof PTC_EXECUTE_CODE_CELL_ENABLED_ENV
      | typeof PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV
      | typeof PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV
      | typeof PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV,
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
      terminalResultMemoryRetentionMs?: number;
    };

export interface CreatePtcExecuteCodeRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  createBatchCommandRunner?: CreatePtcLabSessionBatchCommandRunner;
  createPlacementCoordinator?: CreatePtcExecuteCodePlacementCoordinator;
  createStandbyPool?: CreatePtcExecuteCodeStandbyPool;
  placementResourceBudgetProvider?: () => PtcExecuteCodePlacementResourceBudget;
  getPlacementContinuityProvenance?: PtcExecuteCodePlacementContinuityProvenanceProvider;
  createEpochBridge?: CreatePtcSessionEpochBridge;
  createCellRegistry?: CreatePtcExecuteCodeCellRegistry;
  startCellProcess?: StartPtcExecuteCodeCellProcess;
  callbackTransportPolicy?: PtcSessionEpochBridgeCallbackPolicy;
  cellTerminalResultStore?: PtcExecuteCodeCellTerminalResultStore;
  ptcCell?: PtcExecuteCodeCellRuntimeConfig;
  burstPlacement?: PtcExecuteCodeBurstPlacementConfig | undefined;
  standbyPlacement?: PtcExecuteCodeStandbyPlacementConfig | undefined;
  packageInstall?: PtcExecuteCodePackageInstallRuntimeConfig | undefined;
  store?: PtcExecuteCodeStoreRuntimeConfig | undefined;
  storeRootForState?: (stateRoot: string) => string;
  realpathStateRoot?: (stateRoot: string) => Promise<string>;
  runtimeRootForState?: (stateRoot: string) => string;
  trustContextId?: string;
}

export function resolvePtcExecuteCodeCellRuntimeConfigFromEnv(
  env: PtcExecuteCodeCellEnv = process.env,
): PtcExecuteCodeCellRuntimeConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV];
  const initialYieldRaw = env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV];
  const runningReapRaw = env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV];
  const terminalMemoryRetentionRaw =
    env[PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV];
  if (enabledRaw === undefined) {
    if (
      initialYieldRaw !== undefined ||
      runningReapRaw !== undefined ||
      terminalMemoryRetentionRaw !== undefined
    ) {
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
    if (
      initialYieldRaw !== undefined ||
      runningReapRaw !== undefined ||
      terminalMemoryRetentionRaw !== undefined
    ) {
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
      terminalResultMemoryRetentionMs:
        terminalMemoryRetentionRaw === undefined
          ? PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS
          : readPtcCellIntegerEnv(
              PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV,
              terminalMemoryRetentionRaw,
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

interface ExecuteCodeStateRuntime {
  canonicalStateRoot: string;
  runtimeRoot: string;
  sessionManager: PtcSessionDockerManager;
  batchRunner: ReturnType<CreatePtcLabSessionBatchCommandRunner>;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  store?: PtcExecuteCodeStore;
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
  return Object.hasOwn(options, 'callbackTransportPolicy');
}

function hasExplicitPtcExecuteCodePackageInstallConfig(
  options: CreatePtcExecuteCodeRuntimeOptions,
): boolean {
  return Object.hasOwn(options, 'packageInstall');
}

function hasExplicitPtcExecuteCodeStoreConfig(
  options: CreatePtcExecuteCodeRuntimeOptions,
): boolean {
  return Object.hasOwn(options, 'store');
}

function hasExplicitPtcExecuteCodeBurstPlacementConfig(
  options: CreatePtcExecuteCodeRuntimeOptions,
): boolean {
  return Object.hasOwn(options, 'burstPlacement');
}

function hasExplicitPtcExecuteCodeStandbyPlacementConfig(
  options: CreatePtcExecuteCodeRuntimeOptions,
): boolean {
  return Object.hasOwn(options, 'standbyPlacement');
}

export function createPtcExecuteCodeRuntime(
  options: CreatePtcExecuteCodeRuntimeOptions = {},
): PtcExecuteCodeRuntime & PtcPackageInstallRuntime {
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
    options.ptcCell.terminalResultMemoryRetentionMs !== undefined &&
    (!Number.isSafeInteger(options.ptcCell.terminalResultMemoryRetentionMs) ||
      options.ptcCell.terminalResultMemoryRetentionMs < 1)
  ) {
    throw new Error(
      'PTC execute_code cell terminalResultMemoryRetentionMs must be a positive safe integer',
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
  const terminalResultMemoryRetentionMs =
    ptcCellConfig?.terminalResultMemoryRetentionMs ??
    PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS;
  const burstPlacementSetting = hasExplicitPtcExecuteCodeBurstPlacementConfig(
    options,
  )
    ? options.burstPlacement
    : resolvePtcExecuteCodeBurstPlacementConfigFromEnv();
  const burstPlacementConfig =
    burstPlacementSetting?.enabled === true ? burstPlacementSetting : undefined;
  if (
    burstPlacementConfig !== undefined &&
    options.placementResourceBudgetProvider === undefined
  ) {
    throw new Error(
      'PTC execute_code burst placement requires a resource budget provider',
    );
  }
  const standbyPlacementSetting =
    hasExplicitPtcExecuteCodeStandbyPlacementConfig(options)
      ? options.standbyPlacement
      : resolvePtcExecuteCodeStandbyPlacementConfigFromEnv();
  const standbyPlacementConfig =
    standbyPlacementSetting?.enabled === true
      ? standbyPlacementSetting
      : undefined;
  if (
    standbyPlacementConfig !== undefined &&
    burstPlacementConfig === undefined
  ) {
    throw new Error(
      'PTC execute_code standby placement requires burst placement',
    );
  }
  const callbackTransportPolicy =
    hasExplicitPtcExecuteCodeCallbackTransportPolicy(options)
      ? options.callbackTransportPolicy
      : resolvePtcExecuteCodeCallbackTransportPolicyFromEnv();
  const packageInstallSetting = hasExplicitPtcExecuteCodePackageInstallConfig(
    options,
  )
    ? options.packageInstall
    : resolvePtcExecuteCodePackageInstallConfigFromEnv();
  const packageInstallConfig =
    packageInstallSetting?.enabled === true ? packageInstallSetting : undefined;
  const storeSetting = hasExplicitPtcExecuteCodeStoreConfig(options)
    ? options.store
    : resolvePtcExecuteCodeStoreConfigFromEnv();
  const storeConfig = storeSetting?.enabled === true ? storeSetting : undefined;
  const installedPackagesNodePath =
    packageInstallConfig === undefined
      ? undefined
      : PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH;
  const stateRuntimes = new Map<string, ExecuteCodeStateRuntime>();
  let shutdownState: 'open' | 'closing' | 'closed' = 'open';
  let shutdownEpoch = 0;
  let cleanupPromise: Promise<PtcExecuteCodeRuntimeCleanupResult> | undefined;
  const cellTerminalResultStore = options.cellTerminalResultStore;
  const persistTerminalResult =
    cellTerminalResultStore === undefined
      ? undefined
      : async (args: {
          stateRoot: string;
          threadId: string;
          cellId: PtcExecuteCodeCellId;
          result: PtcExecuteCodeCellRetainedResult;
        }) => {
          const summarized = summarizeWaitRetainedCell({
            cellId: args.cellId,
            result: args.result,
          });
          if (
            !summarized.ok ||
            !isPtcExecuteCodeTerminalWaitStatus(summarized.value.status) ||
            !('exitCode' in summarized.value)
          ) {
            return undefined;
          }
          try {
            return await cellTerminalResultStore.persist({
              stateRoot: args.stateRoot,
              threadId: args.threadId,
              cellId: args.cellId,
              output: stringifyPtcExecuteCodeWaitSummary(summarized.value),
              status: summarized.value.status,
              exitCode: summarized.value.exitCode,
            });
          } catch {
            logger
              .withContext({
                cellId: args.cellId,
                threadId: args.threadId,
              })
              .warn(
                'failed to persist PTC execute_code terminal result; retaining the result in memory',
              );
            return undefined;
          }
        };
  const cellRegistry =
    ptcCellConfig !== undefined
      ? (options.createCellRegistry ?? createPtcExecuteCodeCellRegistry)({
          runningCellReapAfterMs: ptcCellConfig.runningCellReapAfterMs,
          terminalResultMemoryRetentionMs,
          allowConcurrentCells: burstPlacementConfig !== undefined,
          ...(persistTerminalResult === undefined
            ? {}
            : { persistTerminalResult }),
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

  async function getStateRuntime(stateRoot: string): Promise<
    | { ok: true; value: ExecuteCodeStateRuntime }
    | {
        ok: false;
        reasonCode: 'ptc_lab_session_unavailable';
        message: string;
        diagnostics: Record<string, string | number | boolean>;
      }
  > {
    if (shutdownState !== 'open') {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC execute_code runtime is shutting down',
        diagnostics: { shutdownState, shutdownEpoch },
      };
    }
    let canonicalStateRoot: string;
    try {
      canonicalStateRoot = await resolvePtcCanonicalStateRoot({
        stateRoot,
        realpathStateRoot: options.realpathStateRoot,
      });
    } catch {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC execute_code state root is unavailable',
        diagnostics: { stateRootRealpathFailed: true },
      };
    }

    if (shutdownState !== 'open') {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC execute_code runtime is shutting down',
        diagnostics: { shutdownState, shutdownEpoch },
      };
    }

    const current = stateRuntimes.get(canonicalStateRoot);
    if (current !== undefined) {
      return { ok: true, value: current };
    }

    const runtimeRoot = resolvePtcRuntimeRoot({
      stateRoot: canonicalStateRoot,
      runtimeRootForState: options.runtimeRootForState,
      runtimeLabel: 'execute_code',
    });

    const createSessionManager =
      options.createSessionManager ?? createPtcSessionDockerManager;
    const sessionPolicy =
      packageInstallConfig === undefined
        ? createPtcSessionDockerLocalBatchCommandPolicy()
        : createPtcSessionDockerOpenNetworkPackageInstallPolicy({
            tmpTmpfsSize: packageInstallConfig.tmpTmpfsSize,
          });
    const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
      runtimeRoot,
      policy: sessionPolicy,
      realpathStateRoot: async () => canonicalStateRoot,
      ...(burstPlacementConfig === undefined
        ? {}
        : { reapEphemeralOnFirstUse: true }),
      ...definedPtcProps({
        dockerPath: options.dockerPath,
        commandRunner: options.commandRunner,
      }),
    };

    const sessionManager = createSessionManager(managerArgs);
    const standbyPool =
      standbyPlacementConfig === undefined || burstPlacementConfig === undefined
        ? undefined
        : (options.createStandbyPool ?? createPtcExecuteCodeStandbyPool)({
            config: standbyPlacementConfig,
            perIdentityReadyLimit: standbyPlacementConfig.readySlotTarget,
            sessionManager,
          });
    const createBatchCommandRunner =
      options.createBatchCommandRunner ?? createPtcLabSessionBatchCommandRunner;
    const createPlacementCoordinator =
      options.createPlacementCoordinator ??
      createPtcExecuteCodePlacementCoordinator;
    const runtime = {
      canonicalStateRoot,
      runtimeRoot,
      sessionManager,
      batchRunner: createBatchCommandRunner({ sessionManager }),
      placementCoordinator: createPlacementCoordinator({
        ...(burstPlacementConfig === undefined
          ? {}
          : {
              burstConfig: burstPlacementConfig,
              placementResourceBudgetProvider:
                options.placementResourceBudgetProvider,
              resourceRequirements:
                resolvePtcSessionDockerResourceRequirements(sessionPolicy),
            }),
        ...(standbyPool === undefined ? {} : { standbyPool }),
      }),
      ...(storeConfig === undefined
        ? {}
        : {
            store: createPtcExecuteCodeStore({
              rootDir:
                options.storeRootForState?.(canonicalStateRoot) ??
                join(canonicalStateRoot, '.geulbat', 'ptc', 'store'),
              config: storeConfig,
            }),
          }),
    };
    stateRuntimes.set(canonicalStateRoot, runtime);
    return { ok: true, value: runtime };
  }

  return {
    async executeCode(
      args: ExecuteCodeRuntimeRunArgs,
    ): Promise<PtcExecuteCodeRuntimeResult> {
      const labPolicy =
        packageInstallConfig === undefined
          ? createPtcLabLocalDockerBatchCommandPolicyProjection()
          : createPtcLabLocalDockerOpenNetworkPackageInstallPolicyProjection({
              maxInstallMs: packageInstallConfig.maxInstallMs,
              // The batch runner enforces one per-stream cap, so honor whichever
              // of the stdout/stderr knobs is larger — neither stream should be
              // rejected below its configured budget.
              maxInstallOutputBytes: Math.max(
                packageInstallConfig.maxStdoutBytes,
                packageInstallConfig.maxStderrBytes,
              ),
            });
      const request = validateExecuteCodeRequest(args.request, {
        defaultTimeoutMs: labPolicy.shell.maxCommandMs,
        maxTimeoutMs: labPolicy.shell.maxCommandMs,
      });
      if (!request.ok) {
        return request;
      }
      const sdkProjectionValidation = validatePtcExecuteCodeSdkProjection(
        args.sdkProjection,
      );
      if (!sdkProjectionValidation.ok) {
        return sdkProjectionValidation;
      }

      const stateRuntimeResult = await getStateRuntime(
        args.runContext.stateRoot,
      );
      if (!stateRuntimeResult.ok) {
        return stateRuntimeResult;
      }
      const stateRuntime = stateRuntimeResult.value;

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
        stateRoot: stateRuntime.canonicalStateRoot,
        trustContextId:
          options.trustContextId ?? PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
        ...(args.sdkProjection === undefined
          ? {}
          : { sdkProjectionMount: { ...args.sdkProjection.mount } }),
      };
      const placementOwnerKind = args.runContext.ownerKind ?? 'root_main';
      const getPlacementContinuityProvenance =
        args.placementContinuityProvenance === undefined
          ? options.getPlacementContinuityProvenance
          : () => args.placementContinuityProvenance;
      const usesDetachedCell =
        ptcCellConfig !== undefined && cellRegistry !== undefined;
      let storeExecution: PtcExecuteCodeStoreExecution | undefined;
      if (storeConfig !== undefined && !usesDetachedCell) {
        const store = stateRuntime.store;
        if (store === undefined) {
          return {
            ok: false,
            reasonCode: 'ptc_execute_code_store_unavailable',
            message: 'PTC execute_code store is unavailable',
          };
        }
        const storeExecutionResult = await store.beginExecution({
          threadId: args.runContext.threadId,
          executionId: `ptc_exec_${randomUUID()}`,
        });
        if (!storeExecutionResult.ok) {
          return {
            ok: false,
            reasonCode: 'ptc_execute_code_store_unavailable',
            message: storeExecutionResult.error.message,
            storeError: storeExecutionResult.error,
          };
        }
        storeExecution = storeExecutionResult.value;
      }
      const callbackRuntime = createExecuteCodeCallbackRuntime({
        callbackTransportPolicy,
        toolCallbackHandler: args.toolCallbackHandler,
        ...(storeConfig === undefined
          ? {}
          : {
              storeCallbackHandler: createExecuteCodeStoreCallbackHandler({
                ...(storeExecution === undefined
                  ? {}
                  : { execution: storeExecution }),
              }),
            }),
      });
      const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
        callbacksEnabled: callbackRuntime.toolCallbacksEnabled,
        sdkHelp: args.sdkHelp,
        ...(args.sdkProjection === undefined
          ? {}
          : { sdkProjection: args.sdkProjection }),
        ...(storeConfig === undefined
          ? {}
          : {
              storeMode: usesDetachedCell
                ? ('detached_cell' as const)
                : ('batch_exec' as const),
            }),
      });

      if (ptcCellConfig !== undefined && cellRegistry !== undefined) {
        const runCellAttempt = (runtimeArgs?: {
          onRunningCellSettled?: Parameters<
            typeof runExecuteCodeCellRuntimeAttempt
          >[0]['onRunningCellSettled'];
        }) =>
          runExecuteCodeCellRuntimeAttempt({
            admission: admission.value,
            batchRunner: stateRuntime.batchRunner,
            buildCommand:
              installedPackagesNodePath === undefined
                ? buildNodeExecuteCodeCommand
                : (code, buildArgs) =>
                    buildNodeExecuteCodeCommand(code, {
                      ...buildArgs,
                      installedPackagesNodePath,
                    }),
            callbackRuntime,
            cellRegistry,
            closeCallbackBridge,
            createEpochBridge: options.createEpochBridge,
            dockerPath: options.dockerPath,
            identity,
            ownerKind: placementOwnerKind,
            initialYieldTimeMs:
              request.value.yieldTimeMs ??
              Math.min(
                ptcCellConfig.initialYieldTimeMs,
                request.value.timeoutMs,
              ),
            maybeCreateCallbackBridge,
            placementCoordinator: stateRuntime.placementCoordinator,
            getPlacementContinuityProvenance: getPlacementContinuityProvenance,
            placementResourceSnapshotRef: args.placementResourceSnapshotRef,
            ...definedPtcProps({
              onRunningCellSettled: runtimeArgs?.onRunningCellSettled,
            }),
            request: request.value,
            sdkHelpBundle,
            sessionManager: stateRuntime.sessionManager,
            signal: args.signal,
            startCellProcess: options.startCellProcess,
            ...(stateRuntime.store === undefined
              ? {}
              : { store: stateRuntime.store }),
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
              cellId: currentInvocationResult.cellId,
            });
            if (
              cellState === null ||
              !isPtcExecuteCodeCellStateActive(cellState.state)
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
            (result.value.status === 'queued' ||
              result.value.status === 'running')
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
        ownerKind: placementOwnerKind,
        placementCoordinator: stateRuntime.placementCoordinator,
        getPlacementContinuityProvenance: getPlacementContinuityProvenance,
        placementResourceSnapshotRef: args.placementResourceSnapshotRef,
        request: request.value,
        sdkHelpBundle,
        ...(installedPackagesNodePath === undefined
          ? {}
          : { installedPackagesNodePath }),
        sessionManager: stateRuntime.sessionManager,
        batchRunner: stateRuntime.batchRunner,
        ...(storeExecution === undefined ? {} : { storeExecution }),
        signal: args.signal,
      });
    },

    async installPackages(args): Promise<PtcPackageInstallRuntimeResult> {
      if (packageInstallConfig === undefined) {
        return {
          ok: false,
          reasonCode: 'ptc_package_install_disabled',
          message: 'PTC package install is not enabled',
        };
      }
      const sdkProjectionValidation = validatePtcExecuteCodeSdkProjection(
        args.sdkProjection,
      );
      if (!sdkProjectionValidation.ok) {
        return {
          ok: false,
          reasonCode: 'ptc_package_install_sdk_projection_invalid',
          message: sdkProjectionValidation.message,
          ...(sdkProjectionValidation.diagnostics === undefined
            ? {}
            : { diagnostics: sdkProjectionValidation.diagnostics }),
        };
      }

      // A detached exec cell in this thread runs in the shared session and may
      // be resolving/requiring packages from /tmp/geulbat-packages. The batch
      // runner's single-flight guard does not cover the detached cell process,
      // so reject installs until the cell settles rather than racing npm writes
      // against running user code.
      const cellState = cellRegistry?.readCellState({
        threadId: args.runContext.threadId,
      });
      if (
        cellState !== undefined &&
        cellState !== null &&
        isPtcExecuteCodeCellStateActive(cellState.state)
      ) {
        return {
          ok: false,
          reasonCode: 'ptc_lab_session_busy',
          message:
            'PTC package install cannot run while a detached exec cell is active in this thread',
        };
      }

      const stateRuntimeResult = await getStateRuntime(
        args.runContext.stateRoot,
      );
      if (!stateRuntimeResult.ok) {
        return stateRuntimeResult;
      }
      const stateRuntime = stateRuntimeResult.value;

      const admission = admitPtcExecutionProfile({
        requestedProfile: 'lab',
        labEnabled: true,
        reason: 'explicit_user_request',
        labPolicy:
          createPtcLabLocalDockerOpenNetworkPackageInstallPolicyProjection({
            maxInstallMs: packageInstallConfig.maxInstallMs,
            // Honor the larger of the stdout/stderr knobs (see executeCode).
            maxInstallOutputBytes: Math.max(
              packageInstallConfig.maxStdoutBytes,
              packageInstallConfig.maxStderrBytes,
            ),
          }),
      });
      if (!admission.ok) {
        return {
          ok: false,
          reasonCode: 'ptc_package_install_lab_admission_failed',
          message: admission.message,
          diagnostics: { admissionReasonCode: admission.reasonCode },
        };
      }

      return await runPtcExecuteCodePackageInstall({
        admission: admission.value,
        identity: {
          threadId: args.runContext.threadId,
          stateRoot: stateRuntime.canonicalStateRoot,
          trustContextId:
            options.trustContextId ?? PTC_EXECUTE_CODE_TRUST_CONTEXT_ID,
          ...(args.sdkProjection === undefined
            ? {}
            : { sdkProjectionMount: { ...args.sdkProjection.mount } }),
        },
        batchRunner: stateRuntime.batchRunner,
        request: args.request,
        config: packageInstallConfig,
        runtimeRoot: stateRuntime.runtimeRoot,
        ...definedPtcProps({
          commandRunner: options.commandRunner,
          dockerPath: options.dockerPath,
          signal: args.signal,
        }),
      });
    },

    async waitForCell(args: {
      runContext: {
        threadId: string;
        stateRoot?: string;
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

      for (const stateRuntime of stateRuntimes.values()) {
        stateRuntime.placementCoordinator.refreshQueuedPlacements?.();
      }

      const stateRoot = args.runContext.stateRoot;
      const result = await waitForExecuteCodeCell({
        cellRegistry,
        runContext: args.runContext,
        request: args.request,
        signal: args.signal,
        ...(stateRoot === undefined || cellTerminalResultStore === undefined
          ? {}
          : {
              readDurableOutput: ({ threadId, cellId }) =>
                cellTerminalResultStore.read({
                  stateRoot,
                  threadId,
                  cellId,
                }),
            }),
      });
      if (
        result.ok &&
        result.value.executionSurface === 'node_via_lab_detached_cell' &&
        result.value.status !== 'queued' &&
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
      if (cleanupPromise !== undefined) {
        return await cleanupPromise;
      }
      if (shutdownState === 'closed') {
        return { ok: true };
      }

      shutdownState = 'closing';
      shutdownEpoch += 1;
      for (const runtime of stateRuntimes.values()) {
        runtime.placementCoordinator.beginShutdown();
      }

      const activeCleanup = (async () => {
        try {
          await cellRegistry?.closeAllCells({ reason: 'shutdown' });
          cellInvocationResultsByKey.clear();
          let firstFailure: PtcExecuteCodeRuntimeCleanupResult | undefined;
          let stateRuntimeCount = 0;
          for (const runtime of stateRuntimes.values()) {
            stateRuntimeCount += 1;
            const placementCleanup =
              await runtime.placementCoordinator.reapPlacements?.();
            if (
              placementCleanup !== undefined &&
              !placementCleanup.ok &&
              firstFailure === undefined
            ) {
              firstFailure = placementCleanup;
            }
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
                  stateRuntimeCount,
                },
              };
            }
          }
          if (firstFailure !== undefined) {
            return firstFailure;
          }
          return { ok: true as const };
        } finally {
          for (const runtime of stateRuntimes.values()) {
            runtime.placementCoordinator.finishShutdown();
          }
          stateRuntimes.clear();
          shutdownState = 'closed';
        }
      })();
      cleanupPromise = activeCleanup;
      try {
        return await activeCleanup;
      } finally {
        if (cleanupPromise === activeCleanup) {
          cleanupPromise = undefined;
        }
      }
    },
  };
}

function isPtcExecuteCodeTerminalWaitStatus(
  value: unknown,
): value is PtcExecuteCodeRuntimeCellTerminalStatus {
  return (
    value === 'completed' ||
    value === 'terminated' ||
    value === 'completed_with_cleanup_failure' ||
    value === 'terminated_with_cleanup_failure'
  );
}

function validatePtcExecuteCodeSdkProjection(
  projection: PtcExecuteCodeRuntimeSdkProjection | undefined,
): { ok: true } | Extract<PtcExecuteCodeRuntimeResult, { ok: false }> {
  if (projection === undefined) {
    return { ok: true };
  }
  if (
    projection.runtimeCompatibilityRange !==
    PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_sdk_protocol_mismatch',
      message:
        'The pinned PTC SDK projection does not match the active callback protocol',
      remediation:
        'Refresh the thread SDK projection and start a new exec before retrying.',
      diagnostics: {
        expectedProtocolVersion: PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
        receivedProtocolVersion: projection.runtimeCompatibilityRange,
      },
    };
  }
  if (
    projection.importSpecifier !==
    PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'The pinned PTC SDK projection uses an invalid import specifier',
      remediation:
        'Refresh the thread SDK projection and use the reserved geulbat-sdk import.',
    };
  }
  const mount = projection.mount;
  if (
    !isAbsolute(mount.hostRootPath) ||
    mount.containerRootPath !== PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT ||
    mount.mountPolicyId !== PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID ||
    mount.sdkVersion !== projection.sdkVersion ||
    mount.sdkProjectionHash !== projection.sdkProjectionHash ||
    mount.policyId !== projection.policyId ||
    mount.importSpecifier !== projection.importSpecifier ||
    !isSafePtcSdkModulePath(projection.manifestModule) ||
    !/^sha256:[0-9a-f]{64}$/u.test(projection.manifestSourceHash) ||
    projection.modules.some(
      (module) =>
        !module.specifier.startsWith(`${projection.importSpecifier}/`) ||
        !isSafePtcSdkModulePath(module.modulePath) ||
        !/^sha256:[0-9a-f]{64}$/u.test(module.sourceHash),
    )
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'The pinned PTC SDK projection mount is invalid',
      remediation:
        'Refresh the thread SDK projection before starting a new exec.',
    };
  }
  return { ok: true };
}

function isSafePtcSdkModulePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
      )
  );
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
