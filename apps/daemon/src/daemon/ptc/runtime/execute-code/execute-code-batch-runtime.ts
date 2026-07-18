import { definedPtcProps, isPtcRecord } from '../../shared/record-shape.js';
import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import {
  adaptPtcSessionDockerCommandRunner,
  type PtcLabBatchCommandExecutionSummary,
} from '../../lab/shell/lab-command-execution.js';
import type {
  PtcEpochCallbackHandler,
  PtcEpochCallbackHandlerInvocation,
} from '../../callback/epoch-callback.js';
import {
  createPtcSessionEpochBridge,
  type PtcSessionEpochBridge,
  type PtcSessionEpochBridgeCallbackPolicy,
  type PtcSessionEpochBridgeFailureReason,
} from '../../callback/session-epoch-bridge.js';
import type {
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type {
  buildPtcExecuteCodeSdkHelpBundle,
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
} from './execute-code-sdk.js';
import {
  buildPtcExecuteCodeGeulbatFacadeSource,
  buildPtcExecuteCodeReservedSdkRequireSource,
} from './execute-code-sdk.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeCallbackEffectPolicy,
  type PtcExecuteCodeExecutionPlacement,
  type PtcExecuteCodePlacementBatchRunner,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
} from './execute-code-placement-contract.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodePlacementResourceSnapshotRef,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSummary,
  type PtcExecuteCodeStoreError,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
  type ValidatedExecuteCodeRequest,
} from './execute-code-runtime-contract.js';
import type { PtcExecuteCodeStoreExecution } from './execute-code-store.js';

type CreatePtcSessionEpochBridge = typeof createPtcSessionEpochBridge;

type ExecuteCodeBatchCommandResult = Awaited<
  ReturnType<
    PtcExecuteCodeExecutionPlacement['batchRunner']['runPtcLabSessionBatchCommand']
  >
>;

export type PtcExecuteCodeCallbackRuntime =
  | {
      enabled: true;
      toolCallbacksEnabled: boolean;
      callbackPolicy: PtcSessionEpochBridgeCallbackPolicy;
      observedCount(this: void): number;
      callbackHandler: PtcEpochCallbackHandler;
    }
  | {
      enabled: false;
      toolCallbacksEnabled: boolean;
      callbackPolicy?: undefined;
      observedCount(this: void): number;
      callbackHandler: PtcEpochCallbackHandler;
    };

export async function runExecuteCodeRuntimeAttempt(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: ReturnType<typeof createExecuteCodeCallbackRuntime>;
  commandRunner: PtcSessionDockerCommandRunner | undefined;
  createEpochBridge: CreatePtcSessionEpochBridge | undefined;
  dockerPath: string | undefined;
  identity: PtcSessionDockerIdentity;
  ownerKind: 'root_main' | 'child';
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  getPlacementContinuityProvenance:
    | PtcExecuteCodePlacementContinuityProvenanceProvider
    | undefined;
  placementResourceSnapshotRef:
    | PtcExecuteCodePlacementResourceSnapshotRef
    | undefined;
  request: ValidatedExecuteCodeRequest;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  installedPackagesNodePath?: string;
  signal: AbortSignal | undefined;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
  storeExecution?: PtcExecuteCodeStoreExecution;
}): Promise<PtcExecuteCodeRuntimeResult> {
  const placementResult = await args.placementCoordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: args.ownerKind,
    continuity: classifyPtcExecuteCodePlacementContinuity(
      args.getPlacementContinuityProvenance?.({
        kind: 'batch_command',
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
    ...definedPtcProps({
      resourceSnapshotRef: args.placementResourceSnapshotRef,
      signal: args.signal,
    }),
  });
  if (!placementResult.ok) {
    return {
      ...placementResult,
      ...discardStoreExecution(args.storeExecution),
    };
  }
  if ('queued' in placementResult) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_session_busy',
      message: 'PTC batch execution cannot hold a hidden placement queue',
      remediation:
        'Enable the detached-cell exec lane so queued placement can be observed through wait.',
      diagnostics: { placementQueued: true },
      ...discardStoreExecution(args.storeExecution),
    };
  }
  const placement = placementResult.value;
  try {
    const bridgeResult = await maybeCreateCallbackBridge({
      callbackRuntime: args.callbackRuntime,
      identity: placement.identity,
      sessionManager: placement.sessionManager,
      createEpochBridge: args.createEpochBridge,
      signal: args.signal,
    });
    if (!bridgeResult.ok) {
      const cleanup = await placement.sessionManager.close(placement.identity);
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_callback_bridge_unavailable',
        message: bridgeResult.message,
        diagnostics: {
          ...(bridgeResult.diagnostics ?? {}),
          bridgeReasonCode: bridgeResult.reasonCode,
          ...(cleanup.ok ? {} : { cleanupReasonCode: cleanup.reasonCode }),
        },
        ...discardStoreExecution(args.storeExecution),
      };
    }

    const command = buildNodeExecuteCodeCommand(args.request.code, {
      sdkHelpBundle: args.sdkHelpBundle,
      ...(args.installedPackagesNodePath === undefined
        ? {}
        : { installedPackagesNodePath: args.installedPackagesNodePath }),
      ...(bridgeResult.value.bridge === undefined
        ? {}
        : {
            callbackConfig: {
              socketPath: bridgeResult.value.bridge.callbackSocketContainerPath,
              token: bridgeResult.value.bridge.token,
            },
          }),
    });
    const execution = await runExecuteCodeBatchCommand({
      admission: args.admission,
      command,
      commandRunner: args.commandRunner,
      dockerPath: args.dockerPath,
      placement,
      request: args.request,
      signal: args.signal,
    });

    const bridgeClose = await closeCallbackBridge(bridgeResult.value.bridge);
    const bridgeFailureSessionClose = bridgeClose.ok
      ? undefined
      : await placement.sessionManager.close(placement.identity);
    if (!bridgeClose.ok || bridgeFailureSessionClose?.ok === false) {
      const cleanupDiagnostics = {
        ...(!bridgeClose.ok ? { callbackBridgeCloseFailed: true } : {}),
        ...(bridgeFailureSessionClose?.ok === false
          ? {
              sessionCloseFailed: true,
              sessionReasonCode: bridgeFailureSessionClose.reasonCode,
            }
          : {}),
      };
      if (!execution.ok) {
        return {
          ...execution,
          diagnostics: mergeDiagnostics(
            execution.diagnostics,
            cleanupDiagnostics,
          ),
          ...discardStoreExecution(args.storeExecution),
        };
      }
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code session cleanup failed',
        diagnostics: cleanupDiagnostics,
        ...discardStoreExecution(args.storeExecution),
      };
    }

    if (!execution.ok) {
      return {
        ...execution,
        ...discardStoreExecution(args.storeExecution),
      };
    }

    const summaryArgs = {
      toolCallbacksEnabled: args.callbackRuntime.toolCallbacksEnabled,
      toolCallbackCount: args.callbackRuntime.observedCount(),
      sdkProtocolVersion: args.sdkHelpBundle.protocolVersion,
      sdkCallbackToolCount: args.sdkHelpBundle.callbacks.tools.length,
      sensitiveMarkers:
        bridgeResult.value.bridge === undefined
          ? []
          : [
              bridgeResult.value.bridge.token,
              bridgeResult.value.bridge.callbackSocketContainerPath,
              bridgeResult.value.bridge.callbackSocketHostPath,
            ],
    };
    if (execution.value.exitCode !== 0) {
      return {
        ok: true,
        value: summarizeExecution(execution.value, {
          ...summaryArgs,
          ...discardStoreExecution(args.storeExecution),
        }),
      };
    }

    if (args.storeExecution !== undefined) {
      const pendingWriteCount = args.storeExecution.pendingWriteCount();
      const commit = await args.storeExecution.commit();
      if (!commit.ok) {
        return buildPtcExecuteCodeStoreCommitFailure(
          commit.error,
          summarizeExecution(execution.value, summaryArgs),
          pendingWriteCount,
        );
      }
      return {
        ok: true,
        value: summarizeExecution(execution.value, {
          ...summaryArgs,
          store: commit.value,
        }),
      };
    }

    return {
      ok: true,
      value: summarizeExecution(execution.value, summaryArgs),
    };
  } finally {
    await args.placementCoordinator.releasePlacement(placement);
  }
}

async function runExecuteCodeBatchCommand(args: {
  admission: PtcLabAdmittedProfile;
  command: string;
  commandRunner: PtcSessionDockerCommandRunner | undefined;
  dockerPath: string | undefined;
  placement: PtcExecuteCodeExecutionPlacement;
  request: ValidatedExecuteCodeRequest;
  signal: AbortSignal | undefined;
}): Promise<ExecuteCodeBatchCommandResult> {
  try {
    const commandRunner =
      args.commandRunner === undefined
        ? undefined
        : adaptPtcSessionDockerCommandRunner(args.commandRunner);
    return await args.placement.batchRunner.runPtcLabSessionBatchCommand({
      admission: args.admission,
      identity: args.placement.identity,
      request: {
        command: args.command,
        timeoutMs: args.request.timeoutMs,
      },
      ...definedPtcProps({
        runner: commandRunner,
        dockerPath: args.dockerPath || undefined,
        signal: args.signal,
      }),
    });
  } catch {
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC execute_code batch command failed',
      diagnostics: { executeCodeRuntimeThrew: true },
    };
  }
}

export function buildNodeExecuteCodeCommand(
  code: string,
  args: {
    callbackConfig?: { socketPath: string; token: string };
    sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
    installedPackagesNodePath?: string;
  },
): string {
  const runnerSource = [
    'const __geulbatUserRun = async (console, require, process, geulbat) => {',
    code,
    '};',
    '(async () => {',
    buildPtcExecuteCodeGeulbatFacadeSource({
      ...(args.callbackConfig === undefined
        ? {}
        : { callbackConfig: args.callbackConfig }),
      helpBundle: args.sdkHelpBundle,
    }),
    buildPtcExecuteCodeReservedSdkRequireSource(args.sdkHelpBundle),
    'const value = await __geulbatUserRun(console, __geulbatReservedRequire, process, geulbat);',
    "if (value !== undefined) { const printable = typeof value === 'string' ? value : JSON.stringify(value); if (printable !== undefined) process.stdout.write(`${printable}\\n`); }",
    '})().catch((error) => { const message = error && error.stack ? error.stack : String(error); process.stderr.write(`${message}\\n`); process.exitCode = 1; });',
  ].join('\n');
  const encodedRunner = Buffer.from(runnerSource, 'utf8').toString('base64');
  const decodeRunner =
    "process.stdout.write(Buffer.from(process.argv[1] ?? '', 'base64'))";

  return [
    `GEULBAT_PTC_RUNNER_B64=${shellSingleQuote(encodedRunner)};`,
    ...(args.installedPackagesNodePath === undefined
      ? []
      : [`NODE_PATH=${shellSingleQuote(args.installedPackagesNodePath)}`]),
    // CommonJS-only reachability contract: installed packages are visible to
    // require() through NODE_PATH; ESM bare imports stay out of scope.
    'exec',
    'node',
    '--input-type=commonjs-typescript',
    '-e',
    `"$(node -e ${shellSingleQuote(decodeRunner)} "$GEULBAT_PTC_RUNNER_B64")"`,
  ].join(' ');
}

export function summarizeExecution(
  summary: PtcLabBatchCommandExecutionSummary,
  args: {
    toolCallbacksEnabled: boolean;
    toolCallbackCount: number;
    sdkProtocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    sdkCallbackToolCount: number;
    sensitiveMarkers: string[];
    store?:
      | { committedKeys: string[]; revisions: Record<string, number> }
      | { discardedWrites: number };
    cleanupFailure?: {
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };
  },
): Extract<
  PtcExecuteCodeRuntimeSummary,
  { executionSurface: 'node_via_lab_batch_command' }
> {
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    labPolicyId: summary.policyId,
    profile: 'lab',
    executionClass: 'lab_execute_code',
    executionSurface: 'node_via_lab_batch_command',
    exitCode: summary.exitCode,
    stdout: sanitizeSensitiveMarkers(summary.stdout, args.sensitiveMarkers),
    stderr: sanitizeSensitiveMarkers(summary.stderr, args.sensitiveMarkers),
    effectiveTimeoutMs: summary.effectiveTimeoutMs,
    durationMs: summary.durationMs,
    toolCallbacks: {
      enabled: args.toolCallbacksEnabled,
      observed: args.toolCallbackCount,
    },
    sessionLifecycle: {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    },
    callbackHelp: {
      protocolVersion: args.sdkProtocolVersion,
      helpAvailable: true,
      callbackToolCount: args.sdkCallbackToolCount,
    },
    ...(args.store === undefined ? {} : { store: args.store }),
    ...(args.cleanupFailure !== undefined
      ? { cleanupFailure: args.cleanupFailure }
      : {}),
  };
}

export function createExecuteCodeCallbackRuntime(args: {
  callbackTransportPolicy: PtcSessionEpochBridgeCallbackPolicy | undefined;
  toolCallbackHandler: PtcExecuteCodeRuntimeToolCallbackHandler | undefined;
  storeCallbackHandler?: PtcEpochCallbackHandler;
}): PtcExecuteCodeCallbackRuntime {
  let observed = 0;
  const callbackHandler: PtcEpochCallbackHandler = async (invocation) => {
    if (invocation.kind === 'store_get' || invocation.kind === 'store_set') {
      if (args.storeCallbackHandler === undefined) {
        return {
          ok: false,
          errorCode: 'StoreDisabled',
          message: 'PTC store is not enabled',
          remediation:
            'Use exec without geulbat.store or ask the operator to enable GEULBAT_PTC_STORE_ENABLED.',
        };
      }
      return await args.storeCallbackHandler(invocation);
    }

    if (args.toolCallbackHandler === undefined) {
      return {
        ok: false,
        errorCode: 'ptc_tool_callbacks_disabled',
        message: 'PTC execute_code tool callbacks are disabled',
      };
    }

    const parsed = parseToolCallbackInvocation(invocation);
    if (!parsed.ok) {
      return parsed;
    }

    observed += 1;
    return await args.toolCallbackHandler({
      requestId: invocation.requestId,
      toolName: parsed.value.toolName,
      args: parsed.value.args,
      ...(invocation.cellId !== undefined ? { cellId: invocation.cellId } : {}),
      signal: invocation.signal,
      enterLongWait: invocation.enterLongWait,
    });
  };

  if (
    (args.toolCallbackHandler === undefined &&
      args.storeCallbackHandler === undefined) ||
    args.callbackTransportPolicy === undefined
  ) {
    return {
      enabled: false,
      toolCallbacksEnabled: false,
      observedCount: () => observed,
      callbackHandler,
    };
  }

  return {
    enabled: true,
    toolCallbacksEnabled: args.toolCallbackHandler !== undefined,
    callbackPolicy: args.callbackTransportPolicy,
    observedCount: () => observed,
    callbackHandler,
  };
}

export function createExecuteCodeStoreCallbackHandler(args: {
  execution?:
    | PtcExecuteCodeStoreExecution
    | (() => PtcExecuteCodeStoreExecution | undefined);
}): PtcEpochCallbackHandler {
  return async (invocation) => {
    if (invocation.signal.aborted) {
      return {
        ok: false,
        errorCode: 'StoreExecutionFinalized',
        message: 'The PTC store callback was cancelled before acknowledgement',
        remediation: 'Start a new exec before calling geulbat.store again.',
      };
    }
    const execution =
      typeof args.execution === 'function' ? args.execution() : args.execution;
    if (execution === undefined) {
      return {
        ok: false,
        errorCode: 'StoreDisabled',
        message: 'PTC store is not enabled',
        remediation:
          'Use exec without geulbat.store or ask the operator to enable GEULBAT_PTC_STORE_ENABLED.',
      };
    }
    if (!isPtcRecord(invocation.args)) {
      return {
        ok: false,
        errorCode: 'StoreOptionsInvalid',
        message: 'PTC store callback arguments are invalid',
        remediation:
          'Call geulbat.store.get(key) or geulbat.store.set(key, value).',
      };
    }

    const result =
      invocation.kind === 'store_get'
        ? execution.get(invocation.args.key)
        : invocation.kind === 'store_set'
          ? execution.set(
              invocation.args.key,
              invocation.args.value,
              invocation.args.options,
            )
          : undefined;
    if (result === undefined) {
      return {
        ok: false,
        errorCode: 'StoreOptionsInvalid',
        message: 'PTC store callback kind is invalid',
        remediation:
          'Call geulbat.store.get(key) or geulbat.store.set(key, value).',
      };
    }
    if (!result.ok) {
      return callbackStoreError(result.error);
    }
    return { ok: true, result: result.value };
  };
}

export async function maybeCreateCallbackBridge(args: {
  callbackRuntime: ReturnType<typeof createExecuteCodeCallbackRuntime>;
  identity: PtcSessionDockerIdentity;
  sessionManager: Parameters<CreatePtcSessionEpochBridge>[0]['sessionManager'];
  createEpochBridge: CreatePtcSessionEpochBridge | undefined;
  signal: AbortSignal | undefined;
}): Promise<
  | { ok: true; value: { bridge?: PtcSessionEpochBridge } }
  | {
      ok: false;
      reasonCode: PtcSessionEpochBridgeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    }
> {
  if (!args.callbackRuntime.enabled) {
    return { ok: true, value: {} };
  }
  const result = await (args.createEpochBridge ?? createPtcSessionEpochBridge)({
    identity: args.identity,
    sessionManager: args.sessionManager,
    callbackHandler: args.callbackRuntime.callbackHandler,
    callbackPolicy: args.callbackRuntime.callbackPolicy,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!result.ok) {
    return {
      ok: false,
      reasonCode: result.reasonCode,
      message: result.message,
      ...(result.diagnostics === undefined
        ? {}
        : { diagnostics: result.diagnostics }),
    };
  }
  return { ok: true, value: { bridge: result.value } };
}

export async function closeCallbackBridge(
  bridge: PtcSessionEpochBridge | undefined,
): Promise<{ ok: true } | { ok: false }> {
  if (bridge === undefined) {
    return { ok: true };
  }
  try {
    await bridge.close();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function parseToolCallbackInvocation(
  invocation: PtcEpochCallbackHandlerInvocation,
):
  | { ok: true; value: { toolName: string; args: Record<string, unknown> } }
  | { ok: false; errorCode: string; message: string } {
  if (invocation.kind !== 'geulbat_tool_call') {
    return {
      ok: false,
      errorCode: 'ptc_tool_callback_kind_invalid',
      message: 'PTC execute_code callback kind is invalid',
    };
  }
  if (!isPtcRecord(invocation.args)) {
    return {
      ok: false,
      errorCode: 'ptc_tool_callback_args_invalid',
      message: 'PTC execute_code callback args are invalid',
    };
  }
  const toolName = invocation.args.toolName;
  const callbackArgs = invocation.args.args;
  if (
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    toolName.length > 128 ||
    !isPtcRecord(callbackArgs)
  ) {
    return {
      ok: false,
      errorCode: 'ptc_tool_callback_args_invalid',
      message: 'PTC execute_code callback args are invalid',
    };
  }
  return { ok: true, value: { toolName, args: callbackArgs } };
}

function sanitizeSensitiveMarkers(value: string, markers: string[]): string {
  let sanitized = value;
  for (const marker of markers) {
    if (marker.length > 0) {
      sanitized = sanitized.replaceAll(marker, '[redacted:ptc-callback]');
    }
  }
  return sanitized;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function mergeDiagnostics(
  left: Record<string, string | number | boolean> | undefined,
  right: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return {
    ...(left ?? {}),
    ...right,
  };
}

function callbackStoreError(error: PtcExecuteCodeStoreError): {
  ok: false;
  errorCode: string;
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
} {
  return {
    ok: false,
    errorCode: error.errorCode,
    message: error.message,
    remediation: error.remediation,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function discardStoreExecution(
  execution: PtcExecuteCodeStoreExecution | undefined,
): { store?: { discardedWrites: number } } {
  return execution === undefined ? {} : { store: execution.discard() };
}

export function buildPtcExecuteCodeStoreCommitFailure(
  error: PtcExecuteCodeStoreError,
  execution: ReturnType<typeof summarizeExecution>,
  discardedWrites: number,
): PtcExecuteCodeRuntimeResult {
  return {
    ok: false,
    reasonCode:
      error.errorCode === 'StoreCommitConflict'
        ? 'ptc_execute_code_store_commit_conflict'
        : 'ptc_execute_code_store_commit_failed',
    message: error.message,
    store: { discardedWrites },
    storeError: error,
    execution,
  };
}
