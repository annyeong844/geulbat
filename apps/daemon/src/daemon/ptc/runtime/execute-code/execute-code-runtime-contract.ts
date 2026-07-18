import type { PtcLabSessionBatchCommandFailureReason } from '../../shared/lab-batch-command-contract.js';
import type { PtcSessionDockerSdkProjectionMount } from '../../shared/sdk-projection-mount-contract.js';

export {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
} from '../../shared/sdk-projection-mount-contract.js';

export const PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION =
  'ptc_execute_code_sdk_v1' as const;
export const PTC_EXECUTE_CODE_TOOL_NAME = 'exec' as const;
// Temporary tombstone; see the L2b code-mode contract before deleting.
export const PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME = 'execute_code' as const;
export const PTC_EXECUTE_CODE_WAIT_TOOL_NAME = 'wait' as const;
export const PTC_EXECUTE_CODE_POLICY_ID =
  'ptc_lab_execute_code_batch_node_v1' as const;
export const PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID =
  'ptc-cell-terminal-result' as const;
export const PTC_EXECUTE_CODE_TRUST_CONTEXT_ID = PTC_EXECUTE_CODE_POLICY_ID;
export const PTC_PACKAGE_INSTALL_TOOL_NAME = 'install_packages' as const;
// Session-lifetime cumulative install prefix; exec reaches it through
// NODE_PATH, CommonJS require() only (child spec §5.4).
export const PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX =
  '/tmp/geulbat-packages' as const;
export const PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH =
  '/tmp/geulbat-packages/node_modules' as const;
export const PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS = 1_000;
export const PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS = 60_000;
export const PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS = 1_000;
export const PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS = 300_000;
export type PtcExecuteCodeCellId = `ptc_cell_${string}`;

export interface PtcExecuteCodePlacementResourceSnapshotRef {
  snapshotId: string;
  source: 'agent_resource_budget_provider';
}

export type PtcExecuteCodePlacementResourceMeasurement =
  | { ok: true; value: number }
  | {
      ok: false;
      reasonCode: 'unavailable' | 'invalid';
      message: string;
    };

export interface PtcExecuteCodePlacementResourceBudget {
  resourceSnapshotRef: PtcExecuteCodePlacementResourceSnapshotRef;
  availableParallelism: PtcExecuteCodePlacementResourceMeasurement;
  constrainedMemoryBytes: PtcExecuteCodePlacementResourceMeasurement;
  availableMemoryBytes: PtcExecuteCodePlacementResourceMeasurement;
}

export interface PtcExecuteCodePlacementContinuityProvenance {
  independenceProof?: {
    reason: 'self_contained' | 'map_shard' | 'read_only_analysis';
  };
  warmHandles?: ReadonlyArray<{
    handleId: string;
    kind: 'warm_interpreter' | 'warm_fs' | 'warm_memo';
  }>;
  policyFailClosed?: boolean;
}

interface PtcExecuteCodeRuntimeToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

interface PtcExecuteCodeRuntimeToolOneOfParameters {
  oneOf: PtcExecuteCodeRuntimeToolParameters[];
}

interface PtcExecuteCodeRuntimeToolAnyOfParameters {
  anyOf: PtcExecuteCodeRuntimeToolParameters[];
}

type PtcExecuteCodeRuntimeSdkHelpToolParameters =
  | PtcExecuteCodeRuntimeToolParameters
  | PtcExecuteCodeRuntimeToolOneOfParameters
  | PtcExecuteCodeRuntimeToolAnyOfParameters;

export interface PtcExecuteCodeRuntimeSdkHelpTool {
  name: string;
  description: string;
  parameters: PtcExecuteCodeRuntimeSdkHelpToolParameters;
  // Present only for write-tier callback tools: signals that a call may be
  // rejected with approval_required unless the run auto-approves it.
  requiresApproval?: true;
}

export interface PtcExecuteCodeRuntimeSdkHelp {
  callbackTools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
}

export interface PtcExecuteCodeRuntimeSdkProjection {
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
  runtimeCompatibilityRange: string;
  importSpecifier: string;
  manifestModule: string;
  manifestSourceHash: `sha256:${string}`;
  mount: PtcSessionDockerSdkProjectionMount;
  modules: readonly {
    specifier: string;
    exportName: string;
    modulePath: string;
    sourceHash: `sha256:${string}`;
  }[];
}

export type PtcExecuteCodeStoreErrorCode =
  | 'StoreInvalidKey'
  | 'StoreValueNotSerializable'
  | 'StoreOptionsInvalid'
  | 'StoreMergePolicyUnsupported'
  | 'StoreMaxKeysExceeded'
  | 'StoreMaxValueBytesExceeded'
  | 'StoreMaxTotalBytesExceeded'
  | 'StorePersistenceUnavailable'
  | 'StoreCommitConflict'
  | 'StoreExecutionFinalized'
  | 'StoreCallbackTransportUnavailable'
  | 'StoreDisabled';

export interface PtcExecuteCodeStoreError {
  errorCode: PtcExecuteCodeStoreErrorCode;
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
}

export interface PtcExecuteCodeStoreCommitSummary {
  committedKeys: string[];
  revisions: Record<string, number>;
}

export interface PtcExecuteCodeStoreDiscardSummary {
  discardedWrites: number;
}

export interface PtcExecuteCodeStoreConflict {
  key: string;
  baseRevision: number;
  currentRevision: number;
  lastWriterExecutionId?: string;
}

type PtcExecuteCodeRuntimeToolCallbackResult =
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; message: string };

export type PtcExecuteCodeRuntimeToolCallbackHandler = (invocation: {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  cellId?: string;
  signal: AbortSignal;
  enterLongWait?: () => boolean;
}) => Promise<PtcExecuteCodeRuntimeToolCallbackResult>;

export type PtcExecuteCodeRuntimeFailureReason =
  | 'ptc_execute_code_invalid'
  | 'ptc_sdk_protocol_mismatch'
  | 'ptc_execute_code_cell_busy'
  | 'ptc_execute_code_cell_result_unclaimed'
  | 'ptc_execute_code_callback_bridge_unavailable'
  | 'ptc_execute_code_lab_admission_failed'
  | 'ptc_execute_code_session_cleanup_failed'
  | 'ptc_execute_code_store_unavailable'
  | 'ptc_execute_code_store_commit_conflict'
  | 'ptc_execute_code_store_commit_failed'
  | PtcLabSessionBatchCommandFailureReason;

interface PtcExecuteCodeRuntimeRequest {
  code: string;
  timeoutMs?: number;
  yieldTimeMs?: number;
}

interface PtcExecuteCodeRuntimeCompletedSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  labPolicyId: string;
  profile: 'lab';
  executionClass: 'lab_execute_code';
  executionSurface: 'node_via_lab_batch_command';
  exitCode: number;
  stdout: string;
  stderr: string;
  effectiveTimeoutMs: number;
  durationMs: number;
  toolCallbacks: {
    enabled: boolean;
    observed: number;
  };
  sessionLifecycle: {
    mode: 'runtime_owned_reusable';
    retainedAfterExecution: boolean;
  };
  callbackHelp: {
    protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    helpAvailable: boolean;
    callbackToolCount: number;
  };
  store?: PtcExecuteCodeRuntimeStoreSummary;
  cleanupFailure?: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}

export type PtcExecuteCodeRuntimeStoreSummary =
  | PtcExecuteCodeStoreCommitSummary
  | PtcExecuteCodeStoreDiscardSummary;

interface PtcExecuteCodeRuntimeCellBaseSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  labPolicyId: string;
  profile: 'lab';
  executionClass: 'lab_execute_code';
  executionSurface: 'node_via_lab_detached_cell';
  cellId: PtcExecuteCodeCellId;
  stdout: string;
  stderr: string;
  effectiveTimeoutMs: number;
  durationMs: number;
  toolCallbacks: {
    enabled: boolean;
    observed: number;
  };
  sessionLifecycle: {
    mode: 'runtime_owned_reusable';
    retainedAfterExecution: true;
  };
  callbackHelp: {
    protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    helpAvailable: boolean;
    callbackToolCount: number;
  };
}

interface PtcExecuteCodeRuntimeCellRunningSummary extends PtcExecuteCodeRuntimeCellBaseSummary {
  status: 'running';
}

interface PtcExecuteCodeRuntimeCellQueuedSummary extends PtcExecuteCodeRuntimeCellBaseSummary {
  status: 'queued';
}

export type PtcExecuteCodeRuntimeSummary =
  | PtcExecuteCodeRuntimeCompletedSummary
  | PtcExecuteCodeRuntimeCellRunningSummary
  | PtcExecuteCodeRuntimeCellQueuedSummary;

interface PtcExecuteCodeRuntimeCellWaitBaseSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  executionSurface: 'node_via_lab_detached_cell';
  cellId: PtcExecuteCodeCellId;
}

export type PtcExecuteCodeRuntimeCellTerminalStatus =
  | 'completed'
  | 'terminated'
  | 'completed_with_cleanup_failure'
  | 'terminated_with_cleanup_failure';

export interface PtcExecuteCodeCellDurableOutput {
  outputRef: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  status: PtcExecuteCodeRuntimeCellTerminalStatus;
  exitCode: number | null;
}

export interface PtcExecuteCodeCellTerminalResultStore {
  persist(args: {
    stateRoot: string;
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    output: string;
    status: PtcExecuteCodeRuntimeCellTerminalStatus;
    exitCode: number | null;
  }): Promise<PtcExecuteCodeCellDurableOutput>;
  read(args: {
    stateRoot: string;
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): Promise<
    | { ok: true; value: PtcExecuteCodeCellDurableOutput | undefined }
    | { ok: false; message: string }
  >;
}

interface PtcExecuteCodeRuntimeCellWaitRunningSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'running';
  stdout: string;
  stderr: string;
}

interface PtcExecuteCodeRuntimeCellWaitQueuedSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'queued';
  stdout: string;
  stderr: string;
}

interface PtcExecuteCodeRuntimeCellWaitTerminalSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: Extract<
    PtcExecuteCodeRuntimeCellTerminalStatus,
    'completed' | 'terminated'
  >;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  store?: PtcExecuteCodeRuntimeStoreSummary;
}

interface PtcExecuteCodeRuntimeCellWaitTerminalCleanupFailureSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: Extract<
    PtcExecuteCodeRuntimeCellTerminalStatus,
    'completed_with_cleanup_failure' | 'terminated_with_cleanup_failure'
  >;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  store?: PtcExecuteCodeRuntimeStoreSummary;
  cleanupFailure: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}

interface PtcExecuteCodeRuntimeCellWaitDurableSummary
  extends
    PtcExecuteCodeRuntimeCellWaitBaseSummary,
    PtcExecuteCodeCellDurableOutput {
  offloaded: true;
  recoveryTool: 'read_tool_output';
  summary: string;
}

interface PtcExecuteCodeRuntimeCellWaitMissingSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'missing';
  remediation: 'start_a_new_exec';
}

interface PtcExecuteCodeRuntimeCellWaitExpiredSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'expired';
  remediation: 'start_a_new_exec';
}

export type PtcExecuteCodeRuntimeCellWaitSummary =
  | PtcExecuteCodeRuntimeCellWaitQueuedSummary
  | PtcExecuteCodeRuntimeCellWaitRunningSummary
  | PtcExecuteCodeRuntimeCellWaitTerminalSummary
  | PtcExecuteCodeRuntimeCellWaitTerminalCleanupFailureSummary
  | PtcExecuteCodeRuntimeCellWaitDurableSummary
  | PtcExecuteCodeRuntimeCellWaitMissingSummary
  | PtcExecuteCodeRuntimeCellWaitExpiredSummary;

export function stringifyPtcExecuteCodeWaitSummary(
  summary: PtcExecuteCodeRuntimeCellWaitSummary,
): string {
  if (summary.status === 'missing' || summary.status === 'expired') {
    return JSON.stringify({
      kind: 'ptc_execute_code_cell_wait',
      capabilityId: summary.capabilityId,
      policyId: summary.policyId,
      executionSurface: summary.executionSurface,
      status: summary.status,
      cellId: summary.cellId,
      remediation: summary.remediation,
    });
  }
  if ('outputRef' in summary) {
    return JSON.stringify({
      kind: 'ptc_execute_code_cell_wait',
      capabilityId: summary.capabilityId,
      policyId: summary.policyId,
      executionSurface: summary.executionSurface,
      status: summary.status,
      cellId: summary.cellId,
      exitCode: summary.exitCode,
      offloaded: summary.offloaded,
      outputRef: summary.outputRef,
      fullOutputBytes: summary.fullOutputBytes,
      fullOutputChars: summary.fullOutputChars,
      recoveryTool: summary.recoveryTool,
      summary: summary.summary,
    });
  }

  return JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: summary.capabilityId,
    policyId: summary.policyId,
    executionSurface: summary.executionSurface,
    status: summary.status,
    cellId: summary.cellId,
    ...('exitCode' in summary ? { exitCode: summary.exitCode } : {}),
    stdout: summary.stdout,
    stderr: summary.stderr,
    ...('store' in summary && summary.store !== undefined
      ? { store: summary.store }
      : {}),
  });
}

export type PtcExecuteCodeRuntimeResult =
  | { ok: true; value: PtcExecuteCodeRuntimeSummary }
  | {
      ok: false;
      reasonCode: PtcExecuteCodeRuntimeFailureReason;
      message: string;
      remediation?: string;
      diagnostics?: Record<string, string | number | boolean>;
      store?: PtcExecuteCodeStoreDiscardSummary;
      storeError?: PtcExecuteCodeStoreError;
      execution?: PtcExecuteCodeRuntimeCompletedSummary;
    };

export type PtcExecuteCodeRuntimeWaitFailureReason =
  | PtcExecuteCodeRuntimeFailureReason
  | 'ptc_execute_code_cell_wait_unavailable'
  | 'ptc_execute_code_cell_wait_cancelled'
  | 'ptc_execute_code_store_commit_failed';

export type PtcExecuteCodeRuntimeWaitResult =
  | { ok: true; value: PtcExecuteCodeRuntimeCellWaitSummary }
  | {
      ok: false;
      reasonCode: PtcExecuteCodeRuntimeWaitFailureReason;
      message: string;
      remediation?: string;
      diagnostics?: Record<string, string | number | boolean>;
      store?: PtcExecuteCodeStoreDiscardSummary;
      storeError?: PtcExecuteCodeStoreError;
    };

export type PtcExecuteCodeRuntimeCleanupResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: 'ptc_execute_code_session_cleanup_failed';
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

interface PtcPackageInstallRuntimeRequestPackage {
  name: string;
  // Optional npm version spec: exact (1.3.0), range (^1.3.0, 1.x,
  // ">=1 <2"), or dist-tag (latest, next). Omitted resolves to latest.
  version?: string;
}

export interface PtcPackageInstallRuntimeRequest {
  packages: PtcPackageInstallRuntimeRequestPackage[];
}

// Echo of the effective spec sent to npm (requested version or 'latest').
export interface PtcPackageInstallRequestedPackage {
  name: string;
  version: string;
}

// The exact version npm resolved the requested spec to, from the installed
// dependency closure. resolvedVersion is null when the top-level entry was not
// observed (e.g. closure observation failed).
export interface PtcPackageInstallResolvedPackage {
  name: string;
  requestedSpec: string;
  resolvedVersion: string | null;
  integrity: string | null;
}

export type PtcPackageInstallRuntimeFailureReason =
  | 'ptc_package_install_disabled'
  | 'ptc_package_install_request_invalid'
  | 'ptc_package_install_sdk_projection_invalid'
  | 'ptc_package_install_lab_admission_failed'
  | 'ptc_lab_session_unavailable'
  | PtcLabSessionBatchCommandFailureReason;

export interface PtcPackageInstallRuntimeSummary {
  ok: true;
  capabilityId: typeof PTC_PACKAGE_INSTALL_TOOL_NAME;
  labPolicyId: string;
  profile: 'lab';
  manager: 'npm';
  installMode: 'open_network';
  packages: PtcPackageInstallRequestedPackage[];
  resolvedPackages: PtcPackageInstallResolvedPackage[];
  exitCode: number;
  stdout: string;
  stderr: string;
  effectiveTimeoutMs: number;
  durationMs: number;
  installedPackagesNodePath: typeof PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH;
  sessionLifecycle: {
    mode: 'runtime_owned_reusable';
    retainedAfterExecution: boolean;
  };
  provenance: {
    recorded: boolean;
    dependencyClosureCount: number;
  };
}

export type PtcPackageInstallRuntimeResult =
  | { ok: true; value: PtcPackageInstallRuntimeSummary }
  | {
      ok: false;
      reasonCode: PtcPackageInstallRuntimeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcPackageInstallRuntime {
  installPackages(args: {
    runContext: {
      threadId: string;
      stateRoot: string;
    };
    request: PtcPackageInstallRuntimeRequest;
    sdkProjection?: PtcExecuteCodeRuntimeSdkProjection;
    signal?: AbortSignal;
  }): Promise<PtcPackageInstallRuntimeResult>;
}

export interface PtcExecuteCodeRuntime {
  reapRestartResidue?(args: {
    stateRoot: string;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult>;
  executeCode(args: {
    runContext: {
      threadId: string;
      stateRoot: string;
      ownerKind?: 'root_main' | 'child';
    };
    invocationId?: string;
    request: PtcExecuteCodeRuntimeRequest;
    placementResourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
    placementContinuityProvenance?: PtcExecuteCodePlacementContinuityProvenance;
    sdkHelp?: PtcExecuteCodeRuntimeSdkHelp;
    sdkProjection?: PtcExecuteCodeRuntimeSdkProjection;
    toolCallbackHandler?: PtcExecuteCodeRuntimeToolCallbackHandler;
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeResult>;
  waitForCell(args: {
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
  }): Promise<PtcExecuteCodeRuntimeWaitResult>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult>;
}

// Write-callback tier opt-in (Q5=(a) slice). Lives in the contract so the
// tools/agent layers can consult the knob without crossing into the
// execute-code runtime element.
export const PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV =
  'GEULBAT_PTC_WRITE_CALLBACK_ENABLED' as const;

type PtcExecuteCodeWriteCallbackEnv = Readonly<
  Partial<
    Record<
      typeof PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV,
      string | undefined
    >
  >
>;

interface PtcExecuteCodeWriteCallbackRuntimeConfig {
  enabled: boolean;
}

const PTC_EXECUTE_CODE_WRITE_CALLBACK_DISABLED: PtcExecuteCodeWriteCallbackRuntimeConfig =
  Object.freeze({ enabled: false });
const PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED: PtcExecuteCodeWriteCallbackRuntimeConfig =
  Object.freeze({ enabled: true });

export function resolvePtcExecuteCodeWriteCallbackConfigFromEnv(
  env: PtcExecuteCodeWriteCallbackEnv = process.env,
): PtcExecuteCodeWriteCallbackRuntimeConfig {
  const raw = env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV];
  if (raw === undefined) {
    return PTC_EXECUTE_CODE_WRITE_CALLBACK_DISABLED;
  }
  const value = raw.trim();
  if (value === 'true' || value === '1') {
    return PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED;
  }
  if (value === 'false' || value === '0') {
    return PTC_EXECUTE_CODE_WRITE_CALLBACK_DISABLED;
  }
  throw new Error(
    `invalid ${PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV}: ${value || 'empty'}`,
  );
}

// 검증 통과한 execute_code 실행 요청 — batch 실행과 placement provenance가
// 같은 shape를 공유한다 (구 PtcExecuteCodePlacementRuntimeRequest 병합).
export interface ValidatedExecuteCodeRequest {
  code: string;
  timeoutMs: number;
  yieldTimeMs?: number;
}
