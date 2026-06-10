import { realpath } from 'node:fs/promises';
import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  PTC_BROWSER_NAVIGATE_TRUST_CONTEXT_ID,
  type PtcBrowserNavigateRuntime,
  type PtcBrowserNavigateRuntimeCleanupResult,
  type PtcBrowserNavigateRuntimeResult,
} from './browser-navigate-runtime-contract.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import { createPtcLabOpenEgressLocalPolicy } from './lab-network-policy.js';
import { createPtcLabBrowserUserUrlNavigationPolicy } from './lab-browser-policy.js';
import {
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from './session-docker-contract.js';
import { createPtcSessionDockerManager } from './session-docker.js';
import { runPtcLabBrowserUserUrlNavigation } from './lab-browser-user-url-navigation.js';
import { browserUserUrlNavigationFailure } from './lab-browser-user-url-navigation-contract.js';

type CreatePtcSessionDockerManager = typeof createPtcSessionDockerManager;

export interface CreatePtcBrowserNavigateRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcSessionDockerManager;
  realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  runtimeRootForWorkspace?: (workspaceRoot: string) => string;
  trustContextId?: string;
  now?: () => number;
}

interface BrowserNavigateWorkspaceRuntime {
  canonicalWorkspaceRoot: string;
  labPolicy: PtcLabPolicyProjection;
  sessionManager: PtcSessionDockerManager;
}

export function createPtcBrowserNavigateLabPolicyProjection(): PtcLabPolicyProjection {
  const basePolicy = createPtcLabLocalDockerPolicyProjection();
  return {
    ...basePolicy,
    policyId: PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
    network: createPtcLabOpenEgressLocalPolicy({
      metricsCoverage: 'owner_outcome_only',
    }),
    browser: createPtcLabBrowserUserUrlNavigationPolicy({
      maxActionMs: PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
    }),
  };
}

export function createPtcBrowserNavigateSessionDockerPolicy(
  labPolicy: PtcLabPolicyProjection = createPtcBrowserNavigateLabPolicyProjection(),
): PtcSessionDockerPolicy {
  return {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    labPolicyId: labPolicy.policyId,
    network: labPolicy.network,
    browser: labPolicy.browser,
  };
}

export function createPtcBrowserNavigateRuntime(
  options: CreatePtcBrowserNavigateRuntimeOptions = {},
): PtcBrowserNavigateRuntime {
  const workspaceRuntimes = new Map<string, BrowserNavigateWorkspaceRuntime>();

  async function getWorkspaceRuntime(
    workspaceRoot: string,
  ): Promise<
    | { ok: true; value: BrowserNavigateWorkspaceRuntime }
    | Extract<PtcBrowserNavigateRuntimeResult, { ok: false }>
  > {
    let canonicalWorkspaceRoot: string;
    try {
      canonicalWorkspaceRoot = await resolveCanonicalWorkspaceRoot(
        workspaceRoot,
        options.realpathWorkspaceRoot,
      );
    } catch {
      return browserUserUrlNavigationFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser navigation workspace root is unavailable',
        'session_acquisition',
        { diagnostics: { workspaceRootRealpathFailed: true } },
      );
    }

    const current = workspaceRuntimes.get(canonicalWorkspaceRoot);
    if (current !== undefined) {
      return { ok: true, value: current };
    }

    const labPolicy = createPtcBrowserNavigateLabPolicyProjection();
    const policy = createPtcBrowserNavigateSessionDockerPolicy(labPolicy);
    const createSessionManager =
      options.createSessionManager ?? createPtcSessionDockerManager;
    const managerArgs: Parameters<CreatePtcSessionDockerManager>[0] = {
      runtimeRoot: resolveRuntimeRoot(
        canonicalWorkspaceRoot,
        options.runtimeRootForWorkspace,
      ),
      policy,
      realpathWorkspaceRoot: async () => canonicalWorkspaceRoot,
    };
    if (options.dockerPath !== undefined) {
      managerArgs.dockerPath = options.dockerPath;
    }
    if (options.commandRunner !== undefined) {
      managerArgs.commandRunner = options.commandRunner;
    }

    const runtime = {
      canonicalWorkspaceRoot,
      labPolicy,
      sessionManager: createSessionManager(managerArgs),
    };
    workspaceRuntimes.set(canonicalWorkspaceRoot, runtime);
    return { ok: true, value: runtime };
  }

  return {
    async navigate(args) {
      const workspaceRuntimeResult = await getWorkspaceRuntime(
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
        return browserUserUrlNavigationFailure(
          'ptc_lab_browser_policy_disabled',
          admission.message,
          'policy_admission',
          { diagnostics: { admissionReasonCode: admission.reasonCode } },
        );
      }

      const identity: PtcSessionDockerIdentity = {
        threadId: args.runContext.threadId,
        workspaceRoot: workspaceRuntimeResult.value.canonicalWorkspaceRoot,
        trustContextId:
          options.trustContextId ?? PTC_BROWSER_NAVIGATE_TRUST_CONTEXT_ID,
      };
      return await runPtcLabBrowserUserUrlNavigation({
        admission: admission.value,
        identity,
        sessionManager: workspaceRuntimeResult.value.sessionManager,
        request: args.request,
        ...(options.commandRunner === undefined
          ? {}
          : { commandRunner: options.commandRunner }),
        ...(options.dockerPath === undefined
          ? {}
          : { dockerPath: options.dockerPath }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
    },

    async closeAll(args?: {
      signal?: AbortSignal;
    }): Promise<PtcBrowserNavigateRuntimeCleanupResult> {
      let firstFailure: PtcBrowserNavigateRuntimeCleanupResult | undefined;
      let workspaceRuntimeCount = 0;
      for (const runtime of workspaceRuntimes.values()) {
        workspaceRuntimeCount += 1;
        const cleanup = await runtime.sessionManager.closeAll(
          args?.signal === undefined ? undefined : { signal: args.signal },
        );
        if (!cleanup.ok && firstFailure === undefined) {
          firstFailure = {
            ok: false,
            reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
            message: 'PTC browser navigation session cleanup failed',
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

function resolveRuntimeRoot(
  workspaceRoot: string,
  runtimeRootForWorkspace: ((workspaceRoot: string) => string) | undefined,
): string {
  if (runtimeRootForWorkspace === undefined) {
    throw new Error('PTC browser navigation runtime root resolver is missing');
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
