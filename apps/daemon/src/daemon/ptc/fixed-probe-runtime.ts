import { realpath } from 'node:fs/promises';
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
import { createPtcSessionDockerManager } from './session-docker.js';
import type { PtcSessionDockerCommandRunner } from './session-docker-contract.js';

export const PTC_AGENT_LOOP_FIXED_PROBE_TRUST_CONTEXT_ID =
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
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
  timeoutMs?: number;
  trustContextId?: string;
}

export function createPtcFixedEpochProbeRuntime(
  options: CreatePtcFixedEpochProbeRuntimeOptions = {},
) {
  return {
    async runFixedEpochProbe(
      args: FixedProbeRuntimeRunArgs,
    ): Promise<FixedProbeRuntimeResult> {
      const runtimeRoot = resolveRuntimeRoot(
        args.runContext.workspaceRoot,
        options.runtimeRootForWorkspace,
      );
      const createSessionManager =
        options.createSessionManager ?? createPtcSessionDockerManager;
      const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
        runtimeRoot,
        realpathWorkspaceRoot:
          options.realpathWorkspaceRoot ?? resolveWorkspaceRootRealpath,
      };
      if (options.dockerPath !== undefined) {
        managerArgs.dockerPath = options.dockerPath;
      }
      if (options.commandRunner !== undefined) {
        managerArgs.commandRunner = options.commandRunner;
      }
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
      };
      if (options.commandRunner !== undefined) {
        probeArgs.commandRunner = options.commandRunner;
      }
      if (options.dockerPath !== undefined) {
        probeArgs.dockerPath = options.dockerPath;
      }
      if (options.timeoutMs !== undefined) {
        probeArgs.timeoutMs = options.timeoutMs;
      }
      if (args.signal !== undefined) {
        probeArgs.signal = args.signal;
      }

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

function resolveRuntimeRoot(
  workspaceRoot: string,
  runtimeRootForWorkspace: ((workspaceRoot: string) => string) | undefined,
): string {
  if (runtimeRootForWorkspace === undefined) {
    throw new Error('PTC fixed epoch probe runtime root resolver is missing');
  }
  return runtimeRootForWorkspace(workspaceRoot);
}

async function resolveWorkspaceRootRealpath(
  workspaceRoot: string,
): Promise<string> {
  return await realpath(workspaceRoot);
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
