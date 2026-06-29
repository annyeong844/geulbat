import { definedPtcProps, isPtcRecord } from '../../shared/record-shape.js';
import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import {
  PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS,
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
import {
  buildPtcExecuteCodeGeulbatFacadeSource,
  buildPtcExecuteCodeSdkHelpBundle,
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
} from './execute-code-sdk.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeReadOnlyCallbackEffectPolicy,
  type PtcExecuteCodeExecutionPlacement,
  type PtcExecuteCodePlacementBatchRunner,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodePlacementContinuityProvenanceProvider,
} from './execute-code-placement.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
} from './execute-code-runtime-contract.js';

type CreatePtcSessionEpochBridge = typeof createPtcSessionEpochBridge;

export interface ValidatedExecuteCodeRequest {
  code: string;
  timeoutMs: number;
  yieldTimeMs?: number;
}

type ExecuteCodeBatchCommandResult = Awaited<
  ReturnType<
    PtcExecuteCodeExecutionPlacement['batchRunner']['runPtcLabSessionBatchCommand']
  >
>;

export type PtcExecuteCodeCallbackRuntime =
  | {
      enabled: true;
      callbackPolicy: PtcSessionEpochBridgeCallbackPolicy;
      observedCount(): number;
      callbackHandler: PtcEpochCallbackHandler;
    }
  | {
      enabled: false;
      callbackPolicy?: undefined;
      observedCount(): number;
      callbackHandler: PtcEpochCallbackHandler;
    };

export async function runExecuteCodeRuntimeAttempt(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: ReturnType<typeof createExecuteCodeCallbackRuntime>;
  commandRunner: PtcSessionDockerCommandRunner | undefined;
  createEpochBridge: CreatePtcSessionEpochBridge | undefined;
  dockerPath: string | undefined;
  identity: PtcSessionDockerIdentity;
  placementCoordinator: PtcExecuteCodePlacementCoordinator;
  getPlacementContinuityProvenance:
    | PtcExecuteCodePlacementContinuityProvenanceProvider
    | undefined;
  request: ValidatedExecuteCodeRequest;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  signal: AbortSignal | undefined;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
}): Promise<PtcExecuteCodeRuntimeResult> {
  const placement = await args.placementCoordinator.acquirePlacement({
    kind: 'batch_command',
    continuity: classifyPtcExecuteCodePlacementContinuity(
      args.getPlacementContinuityProvenance?.({
        kind: 'batch_command',
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
    ...definedPtcProps({ signal: args.signal }),
  });
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
      };
    }

    const command = buildNodeExecuteCodeCommand(args.request.code, {
      sdkHelpBundle: args.sdkHelpBundle,
      ...(bridgeResult.value.bridge === undefined
        ? {}
        : {
            callbackConfig: {
              socketPath: bridgeResult.value.bridge.callbackSocketContainerPath,
              token: bridgeResult.value.bridge.token,
            },
          }),
    });
    if (
      Buffer.byteLength(command, 'utf8') >
      PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS
    ) {
      await bridgeResult.value.bridge?.close().catch(() => {});
      const cleanup = await placement.sessionManager.close(placement.identity);
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message: 'PTC execute_code command envelope is too large',
        ...(cleanup.ok
          ? {}
          : { diagnostics: { cleanupReasonCode: cleanup.reasonCode } }),
      };
    }

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
        };
      }
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code session cleanup failed',
        diagnostics: cleanupDiagnostics,
      };
    }

    if (!execution.ok) {
      return execution;
    }

    return {
      ok: true,
      value: summarizeExecution(execution.value, {
        toolCallbacksEnabled: args.callbackRuntime.enabled,
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
      }),
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
  },
): string {
  const encodedCode = Buffer.from(code, 'utf8').toString('base64');
  const runnerSource = [
    '(async () => {',
    "const source = Buffer.from(process.env.GEULBAT_PTC_CODE_B64 ?? '', 'base64').toString('utf8');",
    buildPtcExecuteCodeGeulbatFacadeSource({
      ...(args.callbackConfig === undefined
        ? {}
        : { callbackConfig: args.callbackConfig }),
      helpBundle: args.sdkHelpBundle,
    }),
    'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
    "const run = new AsyncFunction('console', 'require', 'process', 'geulbat', source);",
    'const value = await run(console, require, process, geulbat);',
    "if (value !== undefined) { const printable = typeof value === 'string' ? value : JSON.stringify(value); if (printable !== undefined) process.stdout.write(`${printable}\\n`); }",
    '})().catch((error) => { const message = error && error.stack ? error.stack : String(error); process.stderr.write(`${message}\\n`); process.exitCode = 1; });',
  ].join('\n');

  return [
    `GEULBAT_PTC_CODE_B64=${shellSingleQuote(encodedCode)}`,
    'node',
    '-e',
    shellSingleQuote(runnerSource),
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
    cleanupFailure?: {
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };
  },
): Extract<PtcExecuteCodeRuntimeResult, { ok: true }>['value'] {
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
    ...(args.cleanupFailure !== undefined
      ? { cleanupFailure: args.cleanupFailure }
      : {}),
  };
}

export function createExecuteCodeCallbackRuntime(args: {
  callbackTransportPolicy: PtcSessionEpochBridgeCallbackPolicy | undefined;
  toolCallbackHandler: PtcExecuteCodeRuntimeToolCallbackHandler | undefined;
}): PtcExecuteCodeCallbackRuntime {
  let observed = 0;
  const callbackHandler: PtcEpochCallbackHandler = async (invocation) => {
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
    args.toolCallbackHandler === undefined ||
    args.callbackTransportPolicy === undefined
  ) {
    return {
      enabled: false,
      observedCount: () => observed,
      callbackHandler,
    };
  }

  return {
    enabled: true,
    callbackPolicy: args.callbackTransportPolicy,
    observedCount: () => observed,
    callbackHandler,
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
