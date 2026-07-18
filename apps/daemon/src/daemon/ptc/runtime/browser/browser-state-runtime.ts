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
  type PtcSessionDockerHostUser,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from '../../lab/session/session-docker-contract.js';
import {
  resolvePtcCanonicalStateRoot,
  resolvePtcRuntimeRoot,
} from '../runtime-state.js';

function createPtcBrowserRuntimeSessionDockerPolicy(
  labPolicy: PtcLabPolicyProjection,
): PtcSessionDockerPolicy {
  return {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    labPolicyId: labPolicy.policyId,
    network: labPolicy.network,
    browser: labPolicy.browser,
    ...(labPolicy.browser.mode === 'dom_text_evidence'
      ? PTC_BROWSER_TEXT_EVIDENCE_WARM_CDP_DOCKER_RESOURCES
      : {}),
  };
}

// The DOM text evidence lane now keeps a warm headless Chromium CDP process in
// its session container. The base 128-pid sandbox can fork-starve Chromium at
// startup, so this lane keeps the base image but gets a browser-sized process
// budget and scratch space.
const PTC_BROWSER_TEXT_EVIDENCE_WARM_CDP_DOCKER_RESOURCES = Object.freeze({
  cpus: '2',
  memory: '1g',
  pidsLimit: '512',
  scratchTmpfs: '/geulbat/scratch:rw,noexec,nosuid,nodev,size=512m',
  tmpTmpfs: '/tmp:rw,nosuid,nodev,size=512m',
});

type CreatePtcBrowserSessionManager = typeof createPtcSessionDockerManager;

interface PtcBrowserStateRuntimeOptions {
  dockerPath?: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  createSessionManager?: CreatePtcBrowserSessionManager;
  hostUser?: PtcSessionDockerHostUser;
  realpathStateRoot?: (stateRoot: string) => Promise<string>;
  runtimeRootForState?: (stateRoot: string) => string;
}

export interface PtcBrowserRuntimeOptions extends PtcBrowserStateRuntimeOptions {
  trustContextId?: string;
  now?: () => number;
}

interface PtcBrowserStateRuntime {
  canonicalStateRoot: string;
  labPolicy: PtcLabPolicyProjection;
  sessionManager: PtcSessionDockerManager;
}

interface PtcBrowserStateRunContext {
  threadId: string;
  stateRoot: string;
}

interface PtcBrowserAdmittedStateRuntime {
  admission: PtcLabAdmittedProfile;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
}

interface PtcBrowserStateRuntimeAdmissionFailure {
  reasonCode: PtcProfileAdmissionFailureReason;
  message: string;
}

interface PtcBrowserStateRuntimeUrlRequest {
  url: string;
  timeoutMs?: number;
}

interface PtcBrowserStateRuntimeOperationArgs {
  runContext: PtcBrowserStateRunContext;
  request: PtcBrowserStateRuntimeUrlRequest;
  signal?: AbortSignal;
}

interface PtcBrowserStateRuntimeWarmArgs {
  runContext: PtcBrowserStateRunContext;
  signal?: AbortSignal;
}

interface PtcBrowserStateRuntimeCloseAllArgs {
  signal?: AbortSignal;
}

interface PtcBrowserStateRuntimeOwnerRunArgs {
  admission: PtcLabAdmittedProfile;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcBrowserStateRuntimeUrlRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

type PtcBrowserStateRuntimeUnavailableDiagnostics =
  | { stateRootRealpathFailed: true }
  | { runtimeRootUnavailable: true };

interface PtcBrowserStateRuntimeCleanupFailure<ReasonCode extends string> {
  ok: false;
  reasonCode: ReasonCode;
  message: string;
  diagnostics: {
    cleanupReasonCode: PtcSessionDockerFailureReason;
    stateRuntimeCount: number;
  };
}

type PtcBrowserStateRuntimeCleanupResult<ReasonCode extends string> =
  | { ok: true }
  | PtcBrowserStateRuntimeCleanupFailure<ReasonCode>;

interface PtcBrowserStateRuntimeOwner<
  StateFailure extends { ok: false },
  CleanupFailure extends { ok: false },
> {
  getStateRuntime(
    stateRoot: string,
  ): Promise<{ ok: true; value: PtcBrowserStateRuntime } | StateFailure>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<{ ok: true } | CleanupFailure>;
}

export async function admitPtcBrowserStateRuntime<
  StateFailure extends { ok: false },
  CleanupFailure extends { ok: false },
  AdmissionFailure extends { ok: false },
>(args: {
  owner: PtcBrowserStateRuntimeOwner<StateFailure, CleanupFailure>;
  runContext: PtcBrowserStateRunContext;
  trustContextId: string;
  admissionFailed: (
    failure: PtcBrowserStateRuntimeAdmissionFailure,
  ) => AdmissionFailure;
}): Promise<
  | { ok: true; value: PtcBrowserAdmittedStateRuntime }
  | StateFailure
  | AdmissionFailure
> {
  const stateRuntimeResult = await args.owner.getStateRuntime(
    args.runContext.stateRoot,
  );
  if (!stateRuntimeResult.ok) {
    return stateRuntimeResult;
  }

  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: stateRuntimeResult.value.labPolicy,
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
        stateRoot: stateRuntimeResult.value.canonicalStateRoot,
        trustContextId: args.trustContextId,
      },
      sessionManager: stateRuntimeResult.value.sessionManager,
    },
  };
}

export function createPtcBrowserStateRuntimeOwner<
  StateFailure extends { ok: false },
  CleanupFailureReasonCode extends string,
>(args: {
  options: PtcBrowserStateRuntimeOptions;
  labPolicyId: PtcLabPolicyId;
  createBrowserPolicy: () => PtcLabPolicyProjection['browser'];
  stateRuntimeUnavailable: (
    diagnostics: PtcBrowserStateRuntimeUnavailableDiagnostics,
  ) => StateFailure;
  cleanupFailureReasonCode: CleanupFailureReasonCode;
  cleanupFailureMessage: string;
}): PtcBrowserStateRuntimeOwner<
  StateFailure,
  PtcBrowserStateRuntimeCleanupFailure<CleanupFailureReasonCode>
> {
  const stateRuntimes = new Map<string, PtcBrowserStateRuntime>();

  return {
    async getStateRuntime(stateRoot) {
      let canonicalStateRoot: string;
      try {
        canonicalStateRoot = await resolvePtcCanonicalStateRoot({
          stateRoot,
          realpathStateRoot: args.options.realpathStateRoot,
        });
      } catch {
        return args.stateRuntimeUnavailable({
          stateRootRealpathFailed: true,
        });
      }

      const current = stateRuntimes.get(canonicalStateRoot);
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
          stateRoot: canonicalStateRoot,
          runtimeRootForState: args.options.runtimeRootForState,
          runtimeLabel: 'browser',
        });
      } catch {
        return args.stateRuntimeUnavailable({
          runtimeRootUnavailable: true,
        });
      }
      const managerArgs: Parameters<CreatePtcBrowserSessionManager>[0] = {
        runtimeRoot,
        policy,
        realpathStateRoot: async () => canonicalStateRoot,
      };
      if (args.options.dockerPath !== undefined) {
        managerArgs.dockerPath = args.options.dockerPath;
      }
      if (args.options.commandRunner !== undefined) {
        managerArgs.commandRunner = args.options.commandRunner;
      }
      if (args.options.hostUser !== undefined) {
        managerArgs.hostUser = args.options.hostUser;
      }

      const runtime = {
        canonicalStateRoot,
        labPolicy,
        sessionManager: createSessionManager(managerArgs),
      };
      stateRuntimes.set(canonicalStateRoot, runtime);
      return { ok: true, value: runtime };
    },

    async closeAll(closeArgs) {
      let firstFailure:
        | PtcBrowserStateRuntimeCleanupFailure<CleanupFailureReasonCode>
        | undefined;
      let stateRuntimeCount = 0;
      for (const runtime of stateRuntimes.values()) {
        stateRuntimeCount += 1;
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
              stateRuntimeCount,
            },
          };
        }
      }
      stateRuntimes.clear();
      if (firstFailure !== undefined) {
        return firstFailure;
      }
      return { ok: true };
    },
  };
}

export function createPtcBrowserUrlEvidenceRuntime<
  RuntimeResult extends { ok: boolean },
  CleanupFailureReasonCode extends string,
>(args: {
  options: PtcBrowserRuntimeOptions;
  labPolicyId: PtcLabPolicyId;
  createBrowserPolicy: () => PtcLabPolicyProjection['browser'];
  stateRuntimeUnavailable: (
    diagnostics: PtcBrowserStateRuntimeUnavailableDiagnostics,
  ) => Extract<RuntimeResult, { ok: false }>;
  admissionFailed: (
    failure: PtcBrowserStateRuntimeAdmissionFailure,
  ) => Extract<RuntimeResult, { ok: false }>;
  sessionWarmupFailed?: (
    reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
  ) => Extract<RuntimeResult, { ok: false }>;
  cleanupFailureReasonCode: CleanupFailureReasonCode;
  cleanupFailureMessage: string;
  runEvidence(args: PtcBrowserStateRuntimeOwnerRunArgs): Promise<RuntimeResult>;
}): {
  collectEvidence(
    args: PtcBrowserStateRuntimeOperationArgs,
  ): Promise<RuntimeResult>;
  warmState?(
    args: PtcBrowserStateRuntimeWarmArgs,
  ): Promise<{ ok: true } | Extract<RuntimeResult, { ok: false }>>;
  closeAll(
    args?: PtcBrowserStateRuntimeCloseAllArgs,
  ): Promise<PtcBrowserStateRuntimeCleanupResult<CleanupFailureReasonCode>>;
} {
  const stateRuntimeOwner = createPtcBrowserStateRuntimeOwner({
    options: args.options,
    labPolicyId: args.labPolicyId,
    createBrowserPolicy: args.createBrowserPolicy,
    stateRuntimeUnavailable: args.stateRuntimeUnavailable,
    cleanupFailureReasonCode: args.cleanupFailureReasonCode,
    cleanupFailureMessage: args.cleanupFailureMessage,
  });

  const runtime = {
    async collectEvidence(operationArgs: PtcBrowserStateRuntimeOperationArgs) {
      const stateRuntime = await admitPtcBrowserStateRuntime({
        owner: stateRuntimeOwner,
        runContext: operationArgs.runContext,
        trustContextId: args.options.trustContextId ?? args.labPolicyId,
        admissionFailed: args.admissionFailed,
      });
      if (!stateRuntime.ok) {
        return stateRuntime;
      }

      return await args.runEvidence({
        admission: stateRuntime.value.admission,
        identity: stateRuntime.value.identity,
        sessionManager: stateRuntime.value.sessionManager,
        request: operationArgs.request,
        ...(args.options.commandRunner === undefined
          ? {}
          : { commandRunner: args.options.commandRunner }),
        ...(args.options.dockerPath === undefined
          ? {}
          : { dockerPath: args.options.dockerPath }),
        ...(args.options.now === undefined ? {} : { now: args.options.now }),
        ...(operationArgs.signal === undefined
          ? {}
          : { signal: operationArgs.signal }),
      });
    },

    async closeAll(closeArgs?: PtcBrowserStateRuntimeCloseAllArgs) {
      return await stateRuntimeOwner.closeAll(closeArgs);
    },
  };

  if (args.sessionWarmupFailed === undefined) {
    return runtime;
  }
  const sessionWarmupFailed = args.sessionWarmupFailed;

  return {
    ...runtime,
    async warmState(operationArgs: PtcBrowserStateRuntimeWarmArgs) {
      const stateRuntime = await admitPtcBrowserStateRuntime({
        owner: stateRuntimeOwner,
        runContext: operationArgs.runContext,
        trustContextId: args.options.trustContextId ?? args.labPolicyId,
        admissionFailed: args.admissionFailed,
      });
      if (!stateRuntime.ok) {
        return stateRuntime;
      }

      try {
        const session = await stateRuntime.value.sessionManager.getOrCreate(
          stateRuntime.value.identity,
          operationArgs.signal === undefined
            ? undefined
            : { signal: operationArgs.signal },
        );
        if (!session.ok) {
          return sessionWarmupFailed(session.reasonCode);
        }
      } catch {
        return sessionWarmupFailed('session_manager_threw');
      }

      return { ok: true };
    },
  };
}
