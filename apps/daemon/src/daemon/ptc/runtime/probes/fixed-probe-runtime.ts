import {
  runPtcFixedEpochExecutionProbe,
  type RunPtcFixedEpochExecutionProbeArgs,
} from './fixed-epoch-execution-probe.js';
import type {
  PtcFixedEpochExecutionProbeResult,
  PtcFixedEpochExecutionProbeSummary,
  PtcFixedEpochProbeRuntimeResult,
  PtcFixedProbeDiagnostics,
} from './fixed-probe-runtime-contract.js';
import { createPtcSessionDockerManager } from '../../lab/session/session-docker.js';
import type { PtcSessionDockerCommandRunner } from '../../lab/session/session-docker-contract.js';
import {
  resolvePtcSessionEpochBridgeCallbackPolicyFromEnv,
  type PtcSessionEpochBridgeCallbackPolicy,
} from '../../callback/session-epoch-bridge.js';
import { definedPtcProps } from '../../shared/record-shape.js';
import {
  resolvePtcRuntimeRoot,
  resolvePtcWorkspaceRootRealpath,
} from '../runtime-workspace.js';

const PTC_AGENT_LOOP_FIXED_PROBE_TRUST_CONTEXT_ID =
  'ptc_agent_loop_fixed_probe_v1' as const;

type CreatePtcSessionDockerManager = typeof createPtcSessionDockerManager;
type RunPtcFixedEpochExecutionProbe = typeof runPtcFixedEpochExecutionProbe;
type FixedProbeRuntimeResult = PtcFixedEpochProbeRuntimeResult;
type FixedProbeResult =
  PtcFixedEpochExecutionProbeResult<PtcFixedEpochExecutionProbeSummary>;

interface FixedProbeRuntimeRunArgs {
  runContext: {
    threadId: string;
    workspaceRoot: string;
  };
  signal?: AbortSignal;
}

export interface CreatePtcFixedEpochProbeRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  runProbe?: RunPtcFixedEpochExecutionProbe;
  callbackTransportPolicy?: PtcSessionEpochBridgeCallbackPolicy;
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
  timeoutMs?: number;
  trustContextId?: string;
}

export function createPtcFixedEpochProbeRuntime(
  options: CreatePtcFixedEpochProbeRuntimeOptions = {},
) {
  const callbackTransportPolicy =
    hasExplicitPtcFixedProbeCallbackTransportPolicy(options)
      ? options.callbackTransportPolicy
      : resolvePtcSessionEpochBridgeCallbackPolicyFromEnv();

  return {
    async runFixedEpochProbe(
      args: FixedProbeRuntimeRunArgs,
    ): Promise<FixedProbeRuntimeResult> {
      const runtimeRoot = resolvePtcRuntimeRoot({
        workspaceRoot: args.runContext.workspaceRoot,
        runtimeRootForWorkspace: options.runtimeRootForWorkspace,
        runtimeLabel: 'fixed epoch probe',
      });
      const createSessionManager =
        options.createSessionManager ?? createPtcSessionDockerManager;
      const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
        runtimeRoot,
        realpathWorkspaceRoot:
          options.realpathWorkspaceRoot ?? resolvePtcWorkspaceRootRealpath,
        ...definedPtcProps({
          dockerPath: options.dockerPath,
          commandRunner: options.commandRunner,
        }),
      };
      const sessionManager = createSessionManager(managerArgs);
      const probeArgs: RunPtcFixedEpochExecutionProbeArgs = {
        identity: {
          threadId: args.runContext.threadId,
          workspaceRoot: args.runContext.workspaceRoot,
          trustContextId:
            options.trustContextId ??
            PTC_AGENT_LOOP_FIXED_PROBE_TRUST_CONTEXT_ID,
        },
        sessionManager,
        ...definedPtcProps({
          commandRunner: options.commandRunner,
          dockerPath: options.dockerPath,
          timeoutMs: options.timeoutMs,
          callbackPolicy: callbackTransportPolicy,
          signal: args.signal,
        }),
      };

      let probe: FixedProbeResult;
      try {
        probe = await (options.runProbe ?? runPtcFixedEpochExecutionProbe)(
          probeArgs,
        );
      } catch {
        probe = {
          ok: false,
          reasonCode: 'execution_failed',
          message: 'PTC fixed epoch execution probe failed to execute',
          diagnostics: { probeRuntimeThrew: true },
        };
      }

      const cleanup = await sessionManager.closeAll();
      if (!cleanup.ok) {
        return createSessionCleanupFailureResult({
          probe,
          cleanupReasonCode: cleanup.reasonCode,
        });
      }

      return probe;
    },
  };
}

function hasExplicitPtcFixedProbeCallbackTransportPolicy(
  options: CreatePtcFixedEpochProbeRuntimeOptions,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    options,
    'callbackTransportPolicy',
  );
}

function mergeDiagnostics(
  left: PtcFixedProbeDiagnostics | undefined,
  right: PtcFixedProbeDiagnostics,
): PtcFixedProbeDiagnostics {
  return {
    ...(left ?? {}),
    ...right,
  };
}

function createSessionCleanupFailureResult(args: {
  probe: FixedProbeResult;
  cleanupReasonCode: string;
}): Extract<PtcFixedEpochProbeRuntimeResult, { ok: false }> {
  const cleanupDiagnostics = {
    cleanupReasonCode: args.cleanupReasonCode,
  };
  const underlyingProbeDiagnostics = args.probe.ok
    ? undefined
    : mergeDiagnostics(
        { underlyingReasonCode: args.probe.reasonCode },
        args.probe.diagnostics ?? {},
      );

  return {
    ok: false,
    reasonCode: 'session_cleanup_failed',
    message: 'PTC fixed epoch execution probe session cleanup failed',
    diagnostics: mergeDiagnostics(
      underlyingProbeDiagnostics,
      cleanupDiagnostics,
    ),
  };
}
