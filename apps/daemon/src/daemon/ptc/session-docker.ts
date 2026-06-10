import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import { normalizePtcPackageCacheIdentity } from './lab-package-cache.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import { toPtcLabNetworkIdentitySnapshot } from './lab-network-policy.js';
import { toPtcLabBrowserIdentitySnapshot } from './lab-browser-policy.js';
import { sanitizePtcPrivateMarkers } from './output-redaction.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import { buildPtcSessionDockerCreateArgs } from './session-docker-create-args.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
} from './session-docker-contract.js';
import {
  preparePtcSessionDockerHostDirs,
  ptcSessionDockerHostRootPrepareDiagnostics,
  removePtcSessionDockerHostRoot,
} from './session-docker-host-roots.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
  PtcSessionDockerPolicy,
  PtcSessionDockerResult,
  PtcSessionDockerReuseKey,
} from './session-docker-contract.js';

export function normalizePtcSessionDockerReuseKey(args: {
  identity: PtcSessionDockerIdentity;
  workspaceRootRealpath: string;
  policy: PtcSessionDockerPolicy;
}): PtcSessionDockerReuseKey {
  const packageCacheIdentity = normalizePtcPackageCacheIdentity({
    trustContextId: args.identity.trustContextId,
    workspaceRootRealpath: args.workspaceRootRealpath,
    labPolicyId: args.policy.labPolicyId,
    packageCacheId: args.policy.packageCacheId,
    packageCacheMountPolicyId: args.policy.packageCacheMountPolicyId,
    packageManagerFamilies: args.policy.packageManagerFamilies,
    lifecycleScriptsPolicyId: args.policy.lifecycleScriptsPolicyId,
    networkInstallPolicyId: args.policy.networkInstallPolicyId,
  });
  const base = {
    threadId: args.identity.threadId,
    workspaceRootRealpath: args.workspaceRootRealpath,
    trustContextId: args.identity.trustContextId,
    launchPolicyId: args.policy.launchPolicyId,
    imageRef: args.policy.imageRef,
    imagePolicyId: args.policy.imagePolicyId,
    idleEntrypointVersion: args.policy.idleEntrypointVersion,
    callbackMountPolicyId: args.policy.callbackMountPolicyId,
    artifactWorkspaceMountPolicyId: args.policy.artifactWorkspaceMountPolicyId,
    labPolicyId: packageCacheIdentity.labPolicyId,
    packageCacheId: packageCacheIdentity.packageCacheId,
    packageCacheMountPolicyId: packageCacheIdentity.packageCacheMountPolicyId,
    packageCacheRootContainerPath:
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    packageManagerFamilies: packageCacheIdentity.packageManagerFamilies,
    lifecycleScriptsPolicyId: packageCacheIdentity.lifecycleScriptsPolicyId,
    networkInstallPolicyId: packageCacheIdentity.networkInstallPolicyId,
    network: toPtcLabNetworkIdentitySnapshot(args.policy.network),
    browser: toPtcLabBrowserIdentitySnapshot(args.policy.browser),
    cpus: args.policy.cpus,
    memory: args.policy.memory,
    pidsLimit: args.policy.pidsLimit,
    scratchTmpfs: args.policy.scratchTmpfs,
    tmpTmpfs: args.policy.tmpTmpfs,
    packageCacheIdentityHash: packageCacheIdentity.cacheIdentityHash,
  };
  const identityHash = sha256StableJson(base);
  return { ...base, identityHash };
}

export function createPtcSessionDockerManager(args: {
  runtimeRoot: string;
  dockerPath?: string;
  policy?: PtcSessionDockerPolicy;
  commandRunner?: PtcSessionDockerCommandRunner;
  realpathWorkspaceRoot(workspaceRoot: string): Promise<string>;
  timeoutMs?: number;
}): PtcSessionDockerManager {
  const executable = args.dockerPath ?? 'docker';
  const policy = args.policy ?? PTC_SESSION_DOCKER_DEFAULT_POLICY;
  const timeoutMs = args.timeoutMs ?? 10_000;
  const sessions = new Map<string, PtcSessionDockerHandle>();
  const taintedSessionIdentityHashes = new Set<string>();
  const operationQueues = new Map<string, Promise<unknown>>();
  let closingAll = false;

  async function buildKey(
    identity: PtcSessionDockerIdentity,
  ): Promise<PtcSessionDockerReuseKey> {
    return normalizePtcSessionDockerReuseKey({
      identity,
      workspaceRootRealpath: await args.realpathWorkspaceRoot(
        identity.workspaceRoot,
      ),
      policy,
    });
  }

  async function runDocker(
    dockerArgs: string[],
    signal?: AbortSignal,
  ): Promise<PtcSessionDockerCommandResult> {
    return await (args.commandRunner ?? runPtcSessionDockerCommand)({
      executable,
      args: dockerArgs,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  async function checkDocker(
    signal?: AbortSignal,
  ): Promise<PtcSessionDockerResult<void>> {
    const version = await runDocker(['--version'], signal);
    if (!isSuccessfulExit(version)) {
      return failure('docker_unavailable', 'Docker is unavailable', version);
    }
    const image = await runDocker(
      ['image', 'inspect', policy.imageRef],
      signal,
    );
    if (!isSuccessfulExit(image)) {
      return failure(
        'image_unavailable',
        'PTC session Docker image is unavailable',
        image,
      );
    }
    return { ok: true, value: undefined };
  }

  async function serializeForKey<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operationQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    operationQueues.set(
      key,
      next.finally(() => {
        if (operationQueues.get(key) === next) {
          operationQueues.delete(key);
        }
      }),
    );
    return await next;
  }

  async function startSessionContainer(
    reuseKey: PtcSessionDockerReuseKey,
    signal: AbortSignal | undefined,
  ): Promise<PtcSessionDockerResult<PtcSessionDockerHandle>> {
    const available = await checkDocker(signal);
    if (!available.ok) {
      return available;
    }

    let hostDirs: Awaited<ReturnType<typeof preparePtcSessionDockerHostDirs>>;
    try {
      hostDirs = await preparePtcSessionDockerHostDirs({
        runtimeRoot: args.runtimeRoot,
        reuseKey,
      });
    } catch (error: unknown) {
      return failureDiagnostics(
        'container_host_root_prepare_failed',
        'failed to prepare PTC session host roots',
        ptcSessionDockerHostRootPrepareDiagnostics(error),
      );
    }
    const create = await runDocker(
      buildPtcSessionDockerCreateArgs({
        reuseKey,
        runtimeRoot: args.runtimeRoot,
      }),
      signal,
    );
    if (!isSuccessfulExit(create)) {
      if (
        policy.network.mode === 'open' &&
        isOpenNetworkBackendUnavailable(create.stderr)
      ) {
        return failure(
          'network_backend_unavailable',
          'PTC lab open egress Docker network is unavailable',
          create,
        );
      }
      return failure(
        'container_create_failed',
        'failed to create PTC session container',
        create,
      );
    }

    const containerId = create.stdout.trim();
    if (!/^[A-Za-z0-9_.:-]+$/u.test(containerId)) {
      return failure(
        'container_create_failed',
        'Docker create did not return a valid container id',
        create,
      );
    }
    const start = await runDocker(['start', containerId], signal);
    if (!isSuccessfulExit(start)) {
      const cleanup = await runDocker(['rm', '-f', containerId], signal);
      if (!isSuccessfulExit(cleanup)) {
        return failure(
          'container_start_cleanup_failed',
          'failed to start PTC session container and cleanup failed',
          cleanup,
        );
      }
      return failure(
        'container_start_failed',
        'failed to start PTC session container',
        start,
      );
    }

    const inspect = await runDocker(['inspect', containerId], signal);
    if (
      !isSuccessfulExit(inspect) ||
      !inspectReportsRunning(inspect.stdout, containerId)
    ) {
      const cleanup = await runDocker(['rm', '-f', containerId], signal);
      if (!isSuccessfulExit(cleanup)) {
        return failure(
          'container_start_cleanup_failed',
          'PTC session container inspect failed and cleanup failed',
          cleanup,
        );
      }
      return failure(
        'container_inspect_failed',
        'PTC session container did not inspect as running',
        inspect,
      );
    }

    const handle: PtcSessionDockerHandle = {
      state: 'ready',
      containerId,
      reuseKey,
      callbackRootHostPath: hostDirs.callbackRoot,
      callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
      artifactRootHostPath: hostDirs.artifactRoot,
      artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
      artifactWorkspaceMountPolicyId: reuseKey.artifactWorkspaceMountPolicyId,
      packageCacheRootHostPath: hostDirs.packageCacheRoot,
      packageCacheRootContainerPath:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
      packageCacheId: reuseKey.packageCacheId,
      packageCacheIdentityHash: reuseKey.packageCacheIdentityHash,
    };
    sessions.set(reuseKey.identityHash, handle);
    return { ok: true, value: handle };
  }

  async function removeTrackedSessionContainerAndHostRoot(request: {
    handle: PtcSessionDockerHandle;
    signal: AbortSignal | undefined;
    removeFailureMessage: string;
  }): Promise<PtcSessionDockerResult<void>> {
    const removed = await runDocker(
      ['rm', '-f', request.handle.containerId],
      request.signal,
    );
    if (!isSuccessfulExit(removed)) {
      taintedSessionIdentityHashes.add(request.handle.reuseKey.identityHash);
      return failure(
        'container_remove_failed',
        request.removeFailureMessage,
        removed,
      );
    }
    sessions.delete(request.handle.reuseKey.identityHash);
    taintedSessionIdentityHashes.delete(request.handle.reuseKey.identityHash);
    return await removePtcSessionDockerHostRoot({
      runtimeRoot: args.runtimeRoot,
      reuseKey: request.handle.reuseKey,
    });
  }

  return {
    async getOrCreate(identity, options) {
      const reuseKey = await buildKey(identity);
      const requestedDuringCloseAll = closingAll;
      return await serializeForKey(reuseKey.identityHash, async () => {
        if (requestedDuringCloseAll || closingAll) {
          return {
            ok: false,
            reasonCode: 'manager_closing',
            message: 'PTC session Docker manager is closing',
          };
        }

        const current = sessions.get(reuseKey.identityHash);
        if (current) {
          if (taintedSessionIdentityHashes.has(reuseKey.identityHash)) {
            const cleanup = await removeTrackedSessionContainerAndHostRoot({
              handle: current,
              signal: options?.signal,
              removeFailureMessage:
                'failed to remove tainted PTC session container',
            });
            if (!cleanup.ok) {
              return cleanup;
            }
            return await startSessionContainer(reuseKey, options?.signal);
          }
          const inspect = await runDocker(
            ['inspect', current.containerId],
            options?.signal,
          );
          if (
            isSuccessfulExit(inspect) &&
            inspectReportsRunning(inspect.stdout, current.containerId)
          ) {
            return { ok: true, value: current };
          }
          const cleanup = await removeTrackedSessionContainerAndHostRoot({
            handle: current,
            signal: options?.signal,
            removeFailureMessage:
              'failed to remove crashed PTC session container',
          });
          if (!cleanup.ok) {
            return cleanup;
          }
        }

        return await startSessionContainer(reuseKey, options?.signal);
      });
    },

    async close(identity, options) {
      const reuseKey = await buildKey(identity);
      return await serializeForKey(reuseKey.identityHash, async () => {
        const existing = sessions.get(reuseKey.identityHash);
        if (!existing) {
          return { ok: true, value: undefined };
        }
        return await removeTrackedSessionContainerAndHostRoot({
          handle: existing,
          signal: options?.signal,
          removeFailureMessage: 'failed to remove PTC session container',
        });
      });
    },

    async closeAll(options) {
      closingAll = true;
      try {
        await Promise.allSettled([...operationQueues.values()]);

        let firstFailure: PtcSessionDockerResult<void> | null = null;
        for (const handle of [...sessions.values()]) {
          const result = await serializeForKey(
            handle.reuseKey.identityHash,
            async (): Promise<PtcSessionDockerResult<void>> => {
              const current = sessions.get(handle.reuseKey.identityHash);
              if (!current) {
                return { ok: true, value: undefined };
              }
              return await removeTrackedSessionContainerAndHostRoot({
                handle: current,
                signal: options?.signal,
                removeFailureMessage: 'failed to remove PTC session container',
              });
            },
          );
          if (!result.ok && firstFailure === null) {
            firstFailure = result;
          }
        }
        return firstFailure ?? { ok: true, value: undefined };
      } finally {
        closingAll = false;
      }
    },
  };
}

function isSuccessfulExit(result: PtcSessionDockerCommandResult): boolean {
  return result.kind === 'exit' && result.exitCode === 0;
}

function failure(
  reasonCode: PtcSessionDockerFailureReason,
  message: string,
  result: PtcSessionDockerCommandResult,
): PtcSessionDockerResult<never> {
  return {
    ok: false,
    reasonCode,
    message,
    diagnostics: {
      dockerResultKind: result.kind,
      stderr: sanitizeDockerDiagnostic(result.stderr),
    },
  };
}

function failureDiagnostics(
  reasonCode: PtcSessionDockerFailureReason,
  message: string,
  diagnostics: Record<string, string | number | boolean>,
): PtcSessionDockerResult<never> {
  return { ok: false, reasonCode, message, diagnostics };
}

function sanitizeDockerDiagnostic(value: string): string {
  return sanitizePtcPrivateMarkers(value).slice(0, 512);
}

function inspectReportsRunning(stdout: string, containerId: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return false;
    }
    const first = parsed[0] as
      | { Id?: unknown; State?: { Running?: unknown } }
      | undefined;
    return first?.Id === containerId && first.State?.Running === true;
  } catch {
    return false;
  }
}

function isOpenNetworkBackendUnavailable(stderr: string): boolean {
  return /(?:network\s+\S+\s+not found|no such network|network .* unavailable)/iu.test(
    stderr,
  );
}
