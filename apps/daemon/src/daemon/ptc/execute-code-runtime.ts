import { realpath } from 'node:fs/promises';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerBatchCommandPolicyProjection,
  type PtcLabAdmittedProfile,
} from './lab-profile.js';
import {
  PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS,
  adaptPtcSessionDockerCommandRunner,
  type PtcLabBatchCommandExecutionSummary,
} from './lab-command-execution.js';
import { createPtcLabSessionBatchCommandRunner } from './lab-session-batch-command.js';
import type { PtcLabSessionBatchCommandFailureReason } from './lab-session-batch-command-contract.js';
import type {
  PtcEpochCallbackHandler,
  PtcEpochCallbackHandlerInvocation,
} from './epoch-callback.js';
import {
  createPtcSessionEpochBridge,
  type PtcSessionEpochBridge,
  type PtcSessionEpochBridgeFailureReason,
} from './session-epoch-bridge.js';
import { createPtcSessionDockerManager } from './session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from './session-docker-contract.js';
import {
  buildPtcExecuteCodeGeulbatFacadeSource,
  buildPtcExecuteCodeSdkHelpBundle,
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodeSdkHelp,
} from './execute-code-sdk.js';
import type { PtcExecuteCodeRuntimeToolCallbackHandler } from './execute-code-runtime-contract.js';

export const PTC_EXECUTE_CODE_TOOL_NAME = 'execute_code' as const;
export const PTC_EXECUTE_CODE_POLICY_ID =
  'ptc_lab_execute_code_batch_node_v1' as const;
export const PTC_EXECUTE_CODE_MAX_CODE_BYTES = 20 * 1024;
export const PTC_EXECUTE_CODE_DEFAULT_TIMEOUT_MS = 60_000;
export const PTC_EXECUTE_CODE_MAX_TIMEOUT_MS = 300_000;
export const PTC_EXECUTE_CODE_TRUST_CONTEXT_ID =
  'ptc_lab_execute_code_batch_node_v1' as const;

type CreatePtcSessionDockerManager = typeof createPtcSessionDockerManager;
type CreatePtcLabSessionBatchCommandRunner =
  typeof createPtcLabSessionBatchCommandRunner;
type CreatePtcSessionEpochBridge = typeof createPtcSessionEpochBridge;

interface ExecuteCodeRuntimeRunArgs {
  runContext: {
    threadId: string;
    workspaceRoot: string;
  };
  request: {
    code: string;
    timeoutMs?: number;
  };
  sdkHelp?: PtcExecuteCodeSdkHelp;
  toolCallbackHandler?: PtcExecuteCodeRuntimeToolCallbackHandler;
  signal?: AbortSignal;
}

type ExecuteCodeRuntimeFailureReason =
  | 'ptc_execute_code_invalid'
  | 'ptc_execute_code_callback_bridge_unavailable'
  | 'ptc_execute_code_lab_admission_failed'
  | 'ptc_execute_code_session_cleanup_failed'
  | PtcLabSessionBatchCommandFailureReason;

type ExecuteCodeRuntimeResult =
  | {
      ok: true;
      value: {
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
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
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
      };
    }
  | {
      ok: false;
      reasonCode: ExecuteCodeRuntimeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

type ExecuteCodeRuntimeCleanupResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: 'ptc_execute_code_session_cleanup_failed';
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

interface ValidatedExecuteCodeRequest {
  code: string;
  timeoutMs: number;
}

export interface CreatePtcExecuteCodeRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  createBatchCommandRunner?: CreatePtcLabSessionBatchCommandRunner;
  createEpochBridge?: CreatePtcSessionEpochBridge;
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
  trustContextId?: string;
}

interface ExecuteCodeWorkspaceRuntime {
  canonicalWorkspaceRoot: string;
  sessionManager: PtcSessionDockerManager;
  batchRunner: ReturnType<CreatePtcLabSessionBatchCommandRunner>;
}

export function createPtcExecuteCodeRuntime(
  options: CreatePtcExecuteCodeRuntimeOptions = {},
) {
  const workspaceRuntimes = new Map<string, ExecuteCodeWorkspaceRuntime>();

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
      canonicalWorkspaceRoot = await resolveCanonicalWorkspaceRoot(
        workspaceRoot,
        options.realpathWorkspaceRoot,
      );
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

    const runtimeRoot = resolveRuntimeRoot(
      canonicalWorkspaceRoot,
      options.runtimeRootForWorkspace,
    );

    const createSessionManager =
      options.createSessionManager ?? createPtcSessionDockerManager;
    const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
      runtimeRoot,
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      realpathWorkspaceRoot: async () => canonicalWorkspaceRoot,
    };
    if (options.dockerPath !== undefined) {
      managerArgs.dockerPath = options.dockerPath;
    }
    if (options.commandRunner !== undefined) {
      managerArgs.commandRunner = options.commandRunner;
    }

    const sessionManager = createSessionManager(managerArgs);
    const createBatchCommandRunner =
      options.createBatchCommandRunner ?? createPtcLabSessionBatchCommandRunner;
    const runtime = {
      canonicalWorkspaceRoot,
      sessionManager,
      batchRunner: createBatchCommandRunner({ sessionManager }),
    };
    workspaceRuntimes.set(canonicalWorkspaceRoot, runtime);
    return { ok: true, value: runtime };
  }

  return {
    async executeCode(
      args: ExecuteCodeRuntimeRunArgs,
    ): Promise<ExecuteCodeRuntimeResult> {
      const request = validateExecuteCodeRequest(args.request);
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

      const labPolicy = createPtcLabLocalDockerBatchCommandPolicyProjection();
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
        toolCallbackHandler: args.toolCallbackHandler,
      });
      const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
        callbacksEnabled: callbackRuntime.enabled,
        sdkHelp: args.sdkHelp,
      });

      return await runExecuteCodeRuntimeAttempt({
        admission: admission.value,
        callbackRuntime,
        commandRunner: options.commandRunner,
        createEpochBridge: options.createEpochBridge,
        dockerPath: options.dockerPath,
        identity,
        request: request.value,
        sdkHelpBundle,
        signal: args.signal,
        workspaceRuntime,
      });
    },

    async closeAll(args?: {
      signal?: AbortSignal;
    }): Promise<ExecuteCodeRuntimeCleanupResult> {
      let firstFailure: ExecuteCodeRuntimeCleanupResult | undefined;
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
      if (firstFailure !== undefined) {
        return firstFailure;
      }
      workspaceRuntimes.clear();
      return { ok: true };
    },
  };
}

async function runExecuteCodeRuntimeAttempt(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: ReturnType<typeof createExecuteCodeCallbackRuntime>;
  commandRunner: PtcSessionDockerCommandRunner | undefined;
  createEpochBridge: CreatePtcSessionEpochBridge | undefined;
  dockerPath: string | undefined;
  identity: PtcSessionDockerIdentity;
  request: ValidatedExecuteCodeRequest;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
  signal: AbortSignal | undefined;
  workspaceRuntime: ExecuteCodeWorkspaceRuntime;
}): Promise<ExecuteCodeRuntimeResult> {
  const bridgeResult = await maybeCreateCallbackBridge({
    callbackRuntime: args.callbackRuntime,
    identity: args.identity,
    sessionManager: args.workspaceRuntime.sessionManager,
    createEpochBridge: args.createEpochBridge,
    signal: args.signal,
  });
  if (!bridgeResult.ok) {
    const cleanup = await args.workspaceRuntime.sessionManager.close(
      args.identity,
    );
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_callback_bridge_unavailable',
      message: bridgeResult.message,
      diagnostics: {
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
    Buffer.byteLength(command, 'utf8') > PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS
  ) {
    await bridgeResult.value.bridge?.close().catch(() => {});
    await args.workspaceRuntime.sessionManager.close(args.identity);
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code command envelope is too large',
    };
  }

  let execution: Awaited<
    ReturnType<
      ExecuteCodeWorkspaceRuntime['batchRunner']['runPtcLabSessionBatchCommand']
    >
  >;
  try {
    const commandRunner =
      args.commandRunner === undefined
        ? undefined
        : adaptPtcSessionDockerCommandRunner(args.commandRunner);
    execution =
      await args.workspaceRuntime.batchRunner.runPtcLabSessionBatchCommand({
        admission: args.admission,
        identity: args.identity,
        request: {
          command,
          timeoutMs: args.request.timeoutMs,
        },
        ...(commandRunner ? { runner: commandRunner } : {}),
        ...(args.dockerPath ? { dockerPath: args.dockerPath } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });
  } catch {
    execution = {
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC execute_code batch command failed',
      diagnostics: { executeCodeRuntimeThrew: true },
    };
  }

  const bridgeClose = await closeCallbackBridge(bridgeResult.value.bridge);
  const bridgeFailureSessionClose = bridgeClose.ok
    ? undefined
    : await args.workspaceRuntime.sessionManager.close(args.identity);
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
}

function validateExecuteCodeRequest(request: {
  code: string;
  timeoutMs?: number;
}):
  | Extract<ExecuteCodeRuntimeResult, { ok: false }>
  | {
      ok: true;
      value: ValidatedExecuteCodeRequest;
    } {
  if (
    typeof request.code !== 'string' ||
    request.code.trim().length === 0 ||
    Buffer.byteLength(request.code, 'utf8') > PTC_EXECUTE_CODE_MAX_CODE_BYTES
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code input is invalid',
    };
  }

  const timeoutMs = request.timeoutMs ?? PTC_EXECUTE_CODE_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > PTC_EXECUTE_CODE_MAX_TIMEOUT_MS
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code timeout is invalid',
    };
  }

  return { ok: true, value: { code: request.code, timeoutMs } };
}

function buildNodeExecuteCodeCommand(
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

function summarizeExecution(
  summary: PtcLabBatchCommandExecutionSummary,
  args: {
    toolCallbacksEnabled: boolean;
    toolCallbackCount: number;
    sdkProtocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    sdkCallbackToolCount: number;
    sensitiveMarkers: string[];
  },
): Extract<ExecuteCodeRuntimeResult, { ok: true }>['value'] {
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
    stdoutTruncated: summary.stdoutTruncated,
    stderrTruncated: summary.stderrTruncated,
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
  };
}

function createExecuteCodeCallbackRuntime(args: {
  toolCallbackHandler: PtcExecuteCodeRuntimeToolCallbackHandler | undefined;
}): {
  enabled: boolean;
  observedCount(): number;
  callbackHandler: PtcEpochCallbackHandler;
} {
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
      signal: invocation.signal,
    });
  };

  return {
    enabled: args.toolCallbackHandler !== undefined,
    observedCount: () => observed,
    callbackHandler,
  };
}

async function maybeCreateCallbackBridge(args: {
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
    }
> {
  if (!args.callbackRuntime.enabled) {
    return { ok: true, value: {} };
  }
  const result = await (args.createEpochBridge ?? createPtcSessionEpochBridge)({
    identity: args.identity,
    sessionManager: args.sessionManager,
    callbackHandler: args.callbackRuntime.callbackHandler,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!result.ok) {
    return {
      ok: false,
      reasonCode: result.reasonCode,
      message: result.message,
    };
  }
  return { ok: true, value: { bridge: result.value } };
}

async function closeCallbackBridge(
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
  if (!isRecord(invocation.args)) {
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
    !isRecord(callbackArgs)
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

function resolveRuntimeRoot(
  workspaceRoot: string,
  runtimeRootForWorkspace: ((workspaceRoot: string) => string) | undefined,
): string {
  if (runtimeRootForWorkspace === undefined) {
    throw new Error('PTC execute_code runtime root resolver is missing');
  }
  return runtimeRootForWorkspace(workspaceRoot);
}

async function resolveCanonicalWorkspaceRoot(
  workspaceRoot: string,
  realpathWorkspaceRoot:
    | ((workspaceRoot: string) => Promise<string>)
    | undefined,
): Promise<string> {
  return await (realpathWorkspaceRoot ?? resolveWorkspaceRootRealpath)(
    workspaceRoot,
  );
}

async function resolveWorkspaceRootRealpath(
  workspaceRoot: string,
): Promise<string> {
  return await realpath(workspaceRoot);
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
