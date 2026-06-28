import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerOpenEgressBrowserPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
  type PtcProfileAdmissionFailureReason,
} from '../../lab/profile/lab-profile.js';
import type { PtcLabPolicyId } from '../../lab/profile/lab-profile-contract.js';
import { createPtcSessionDockerManager } from '../../lab/session/session-docker.js';
import {
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerFailureReason,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from '../../lab/session/session-docker-contract.js';
import {
  resolvePtcCanonicalWorkspaceRoot,
  resolvePtcRuntimeRoot,
} from '../runtime-workspace.js';

function createPtcBrowserRuntimeSessionDockerPolicy(
  labPolicy: PtcLabPolicyProjection,
): PtcSessionDockerPolicy {
  return {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    labPolicyId: labPolicy.policyId,
    network: labPolicy.network,
    browser: labPolicy.browser,
  };
}

type CreatePtcBrowserSessionManager = typeof createPtcSessionDockerManager;

interface PtcBrowserWorkspaceRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcBrowserSessionManager;
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
}

export interface PtcBrowserRuntimeOptions extends PtcBrowserWorkspaceRuntimeOptions {
  trustContextId?: string;
  now?: () => number;
}

interface PtcBrowserWorkspaceRuntime {
  canonicalWorkspaceRoot: string;
  labPolicy: PtcLabPolicyProjection;
  sessionManager: PtcSessionDockerManager;
}

interface PtcBrowserWorkspaceRunContext {
  threadId: string;
  workspaceRoot: string;
}

interface PtcBrowserAdmittedWorkspaceRuntime {
  admission: PtcLabAdmittedProfile;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
}

interface PtcBrowserWorkspaceRuntimeAdmissionFailure {
  reasonCode: PtcProfileAdmissionFailureReason;
  message: string;
}

type PtcBrowserWorkspaceRuntimeUnavailableDiagnostics =
  | { workspaceRootRealpathFailed: true }
  | { runtimeRootUnavailable: true };

interface PtcBrowserWorkspaceRuntimeCleanupFailure<ReasonCode extends string> {
  ok: false;
  reasonCode: ReasonCode;
  message: string;
  diagnostics: {
    cleanupReasonCode: PtcSessionDockerFailureReason;
    workspaceRuntimeCount: number;
  };
}

interface PtcBrowserWorkspaceRuntimeOwner<
  WorkspaceFailure extends { ok: false },
  CleanupFailure extends { ok: false },
> {
  getWorkspaceRuntime(
    workspaceRoot: string,
  ): Promise<
    { ok: true; value: PtcBrowserWorkspaceRuntime } | WorkspaceFailure
  >;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<{ ok: true } | CleanupFailure>;
}

export async function admitPtcBrowserWorkspaceRuntime<
  WorkspaceFailure extends { ok: false },
  CleanupFailure extends { ok: false },
  AdmissionFailure extends { ok: false },
>(args: {
  owner: PtcBrowserWorkspaceRuntimeOwner<WorkspaceFailure, CleanupFailure>;
  runContext: PtcBrowserWorkspaceRunContext;
  trustContextId: string;
  admissionFailed: (
    failure: PtcBrowserWorkspaceRuntimeAdmissionFailure,
  ) => AdmissionFailure;
}): Promise<
  | { ok: true; value: PtcBrowserAdmittedWorkspaceRuntime }
  | WorkspaceFailure
  | AdmissionFailure
> {
  const workspaceRuntimeResult = await args.owner.getWorkspaceRuntime(
    args.runContext.workspaceRoot,
  );
  if (!workspaceRuntimeResult.ok) {
    return workspaceRuntimeResult;
  }

  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: workspaceRuntimeResult.value.labPolicy,
  });
  if (!admission.ok) {
    return args.admissionFailed(admission);
  }

  return {
    ok: true,
    value: {
      admission: admission.value,
      identity: {
        threadId: args.runContext.threadId,
        workspaceRoot: workspaceRuntimeResult.value.canonicalWorkspaceRoot,
        trustContextId: args.trustContextId,
      },
      sessionManager: workspaceRuntimeResult.value.sessionManager,
    },
  };
}

export function createPtcBrowserWorkspaceRuntimeOwner<
  WorkspaceFailure extends { ok: false },
  CleanupFailureReasonCode extends string,
>(args: {
  options: PtcBrowserWorkspaceRuntimeOptions;
  labPolicyId: PtcLabPolicyId;
  createBrowserPolicy: () => PtcLabPolicyProjection['browser'];
  workspaceRuntimeUnavailable: (
    diagnostics: PtcBrowserWorkspaceRuntimeUnavailableDiagnostics,
  ) => WorkspaceFailure;
  cleanupFailureReasonCode: CleanupFailureReasonCode;
  cleanupFailureMessage: string;
}): PtcBrowserWorkspaceRuntimeOwner<
  WorkspaceFailure,
  PtcBrowserWorkspaceRuntimeCleanupFailure<CleanupFailureReasonCode>
> {
  const workspaceRuntimes = new Map<string, PtcBrowserWorkspaceRuntime>();

  return {
    async getWorkspaceRuntime(workspaceRoot) {
      let canonicalWorkspaceRoot: string;
      try {
        canonicalWorkspaceRoot = await resolvePtcCanonicalWorkspaceRoot({
          workspaceRoot,
          realpathWorkspaceRoot: args.options.realpathWorkspaceRoot,
        });
      } catch {
        return args.workspaceRuntimeUnavailable({
          workspaceRootRealpathFailed: true,
        });
      }

      const current = workspaceRuntimes.get(canonicalWorkspaceRoot);
      if (current !== undefined) {
        return { ok: true, value: current };
      }

      const labPolicy =
        createPtcLabLocalDockerOpenEgressBrowserPolicyProjection({
          policyId: args.labPolicyId,
          browser: args.createBrowserPolicy(),
        });
      const policy = createPtcBrowserRuntimeSessionDockerPolicy(labPolicy);
      const createSessionManager =
        args.options.createSessionManager ?? createPtcSessionDockerManager;
      let runtimeRoot: string;
      try {
        runtimeRoot = resolvePtcRuntimeRoot({
          workspaceRoot: canonicalWorkspaceRoot,
          runtimeRootForWorkspace: args.options.runtimeRootForWorkspace,
          runtimeLabel: 'browser',
        });
      } catch {
        return args.workspaceRuntimeUnavailable({
          runtimeRootUnavailable: true,
        });
      }
      const managerArgs: Parameters<CreatePtcBrowserSessionManager>[0] = {
        runtimeRoot,
        policy,
        realpathWorkspaceRoot: async () => canonicalWorkspaceRoot,
      };
      if (args.options.dockerPath !== undefined) {
        managerArgs.dockerPath = args.options.dockerPath;
      }
      if (args.options.commandRunner !== undefined) {
        managerArgs.commandRunner = args.options.commandRunner;
      }

      const runtime = {
        canonicalWorkspaceRoot,
        labPolicy,
        sessionManager: createSessionManager(managerArgs),
      };
      workspaceRuntimes.set(canonicalWorkspaceRoot, runtime);
      return { ok: true, value: runtime };
    },

    async closeAll(closeArgs) {
      let firstFailure:
        | PtcBrowserWorkspaceRuntimeCleanupFailure<CleanupFailureReasonCode>
        | undefined;
      let workspaceRuntimeCount = 0;
      for (const runtime of workspaceRuntimes.values()) {
        workspaceRuntimeCount += 1;
        const cleanup = await runtime.sessionManager.closeAll(
          closeArgs?.signal === undefined
            ? undefined
            : { signal: closeArgs.signal },
        );
        if (!cleanup.ok && firstFailure === undefined) {
          firstFailure = {
            ok: false,
            reasonCode: args.cleanupFailureReasonCode,
            message: args.cleanupFailureMessage,
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
