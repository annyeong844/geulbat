import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildPtcPackageCacheRoot,
  normalizePtcPackageCacheIdentity,
  preparePtcPackageCacheRoot,
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  type PtcLabPackageManagerName,
  type PtcPackageCacheIdentity,
} from './lab-package-cache.js';

export const PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT = '/geulbat/callbacks';
export const PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT =
  '/geulbat/artifacts' as const;
export const PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID =
  'ptc_session_artifact_workspace_mount_v1' as const;
const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024;

export interface PtcSessionDockerIdentity {
  threadId: string;
  workspaceRoot: string;
  trustContextId: string;
}

export interface PtcSessionDockerPolicy {
  imageRef: string;
  launchPolicyId: string;
  imagePolicyId: string;
  idleEntrypointVersion: string;
  callbackMountPolicyId: string;
  artifactWorkspaceMountPolicyId: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  cpus: string;
  memory: string;
  pidsLimit: string;
  scratchTmpfs: string;
  tmpTmpfs: string;
}

export interface PtcSessionDockerReuseKey {
  threadId: string;
  workspaceRootRealpath: string;
  trustContextId: string;
  launchPolicyId: string;
  imagePolicyId: string;
  idleEntrypointVersion: string;
  callbackMountPolicyId: string;
  artifactWorkspaceMountPolicyId: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  packageCacheIdentityHash: string;
  identityHash: string;
}

export type PtcSessionDockerState =
  | 'starting'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'crashed';

export type PtcSessionDockerFailureReason =
  | 'docker_unavailable'
  | 'image_unavailable'
  | 'unsupported_platform'
  | 'launch_policy_invalid'
  | 'container_create_failed'
  | 'container_start_failed'
  | 'container_inspect_failed'
  | 'container_crashed'
  | 'container_remove_failed'
  | 'container_host_root_cleanup_failed'
  | 'container_start_cleanup_failed'
  | 'manager_closing';

export type PtcSessionDockerResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcSessionDockerFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcSessionDockerCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

export interface PtcSessionDockerCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PtcSessionDockerCommandRunner = (
  invocation: PtcSessionDockerCommandInvocation,
) => Promise<PtcSessionDockerCommandResult>;

export interface PtcSessionDockerHandle {
  state: 'ready';
  containerId: string;
  reuseKey: PtcSessionDockerReuseKey;
  callbackRootHostPath: string;
  callbackRootContainerPath: typeof PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT;
  artifactRootHostPath: string;
  artifactRootContainerPath: typeof PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT;
  artifactWorkspaceMountPolicyId: string;
  packageCacheRootHostPath: string;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageCacheMountPolicyId: string;
  packageCacheId: string;
  packageCacheIdentityHash: string;
}

export interface PtcSessionDockerManager {
  getOrCreate(
    identity: PtcSessionDockerIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<PtcSessionDockerResult<PtcSessionDockerHandle>>;
  close(
    identity: PtcSessionDockerIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<PtcSessionDockerResult<void>>;
  closeAll(options?: {
    signal?: AbortSignal;
  }): Promise<PtcSessionDockerResult<void>>;
}

export const PTC_SESSION_DOCKER_DEFAULT_POLICY: PtcSessionDockerPolicy =
  Object.freeze({
    imageRef: 'local/geulbat-ptc-session:2026-05-31',
    launchPolicyId: 'ptc_session_docker_launch_v1',
    imagePolicyId: 'ptc_session_docker_image_v1',
    idleEntrypointVersion: 'ptc_session_idle_entrypoint_v1',
    callbackMountPolicyId: 'ptc_session_callback_mount_v1',
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    labPolicyId: 'ptc_lab_local_docker_policy_v1',
    packageCacheId: PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
    packageCacheMountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
    packageManagerFamilies: [],
    lifecycleScriptsPolicyId: PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
    networkInstallPolicyId: PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
    cpus: '1',
    memory: '512m',
    pidsLimit: '128',
    scratchTmpfs: '/geulbat/scratch:rw,noexec,nosuid,nodev,size=64m',
    tmpTmpfs: '/tmp:rw,nosuid,nodev,size=64m',
  });

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
    packageCacheIdentityHash: packageCacheIdentity.cacheIdentityHash,
  };
  const identityHash = createHash('sha256')
    .update(stableStringify(base), 'utf8')
    .digest('hex');
  return { ...base, identityHash };
}

export function buildPtcSessionDockerCallbackRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(buildPtcSessionDockerSessionRoot(args), 'callbacks');
}

export function buildPtcSessionDockerSessionRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(args.runtimeRoot, 'ptc-sessions', args.reuseKey.identityHash);
}

export function buildPtcSessionDockerArtifactRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(buildPtcSessionDockerSessionRoot(args), 'artifacts');
}

function toPtcPackageCacheIdentity(
  reuseKey: PtcSessionDockerReuseKey,
): PtcPackageCacheIdentity {
  return {
    trustContextId: reuseKey.trustContextId,
    workspaceRootRealpath: reuseKey.workspaceRootRealpath,
    labPolicyId: reuseKey.labPolicyId,
    packageCacheId: reuseKey.packageCacheId,
    packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
    packageManagerFamilies: reuseKey.packageManagerFamilies,
    lifecycleScriptsPolicyId: reuseKey.lifecycleScriptsPolicyId,
    networkInstallPolicyId: reuseKey.networkInstallPolicyId,
    cacheIdentityHash: reuseKey.packageCacheIdentityHash,
  };
}

export async function preparePtcSessionDockerHostDirs(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<{
  callbackRoot: string;
  artifactRoot: string;
  packageCacheRoot: string;
}> {
  const sessionsRoot = join(args.runtimeRoot, 'ptc-sessions');
  const sessionRoot = buildPtcSessionDockerSessionRoot(args);
  const callbackRoot = buildPtcSessionDockerCallbackRoot(args);
  const artifactRoot = buildPtcSessionDockerArtifactRoot(args);
  const packageCacheRoot = await preparePtcPackageCacheRoot({
    runtimeRoot: args.runtimeRoot,
    identity: toPtcPackageCacheIdentity(args.reuseKey),
  });
  await mkdir(sessionsRoot, { recursive: true });
  await chmod(sessionsRoot, 0o700).catch(() => {});
  await mkdir(sessionRoot, { recursive: true });
  await chmod(sessionRoot, 0o700).catch(() => {});
  await mkdir(callbackRoot, { recursive: true });
  await chmod(callbackRoot, 0o700).catch(() => {});
  await mkdir(artifactRoot, { recursive: true });
  await chmod(artifactRoot, 0o700).catch(() => {});
  return {
    callbackRoot,
    artifactRoot,
    packageCacheRoot: packageCacheRoot.hostPath,
  };
}

async function removePtcSessionDockerHostRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<PtcSessionDockerResult<void>> {
  try {
    await rm(buildPtcSessionDockerSessionRoot(args), {
      recursive: true,
      force: true,
    });
    return { ok: true, value: undefined };
  } catch {
    return {
      ok: false,
      reasonCode: 'container_host_root_cleanup_failed',
      message: 'failed to clean PTC session host root',
      diagnostics: { cleanupFailed: true },
    };
  }
}

export function buildPtcSessionDockerCreateArgs(args: {
  reuseKey: PtcSessionDockerReuseKey;
  runtimeRoot: string;
  policy: PtcSessionDockerPolicy;
}): string[] {
  const callbackRoot = buildPtcSessionDockerCallbackRoot({
    runtimeRoot: args.runtimeRoot,
    reuseKey: args.reuseKey,
  });
  const artifactRoot = buildPtcSessionDockerArtifactRoot({
    runtimeRoot: args.runtimeRoot,
    reuseKey: args.reuseKey,
  });
  const packageCacheRoot = buildPtcPackageCacheRoot({
    runtimeRoot: args.runtimeRoot,
    identity: toPtcPackageCacheIdentity(args.reuseKey),
  });

  return [
    'create',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    args.policy.scratchTmpfs,
    '--tmpfs',
    args.policy.tmpTmpfs,
    '--mount',
    `type=bind,src=${callbackRoot},dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT},rw`,
    '--mount',
    `type=bind,src=${artifactRoot},dst=${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT},rw`,
    '--mount',
    `type=bind,src=${packageCacheRoot.hostPath},dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT},rw`,
    '--cpus',
    args.policy.cpus,
    '--memory',
    args.policy.memory,
    '--pids-limit',
    args.policy.pidsLimit,
    '-e',
    'HOME=/geulbat/scratch/home',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'XDG_CACHE_HOME=/geulbat/scratch/cache',
    '--label',
    'geulbat.kind=ptc-session',
    '--label',
    'geulbat.owner=daemon',
    '--label',
    `geulbat.identityHash=${args.reuseKey.identityHash}`,
    '--label',
    `geulbat.launchPolicyId=${args.reuseKey.launchPolicyId}`,
    '--label',
    `geulbat.imagePolicyId=${args.reuseKey.imagePolicyId}`,
    '--label',
    `geulbat.callbackMountPolicyId=${args.reuseKey.callbackMountPolicyId}`,
    '--label',
    `geulbat.artifactWorkspaceMountPolicyId=${args.reuseKey.artifactWorkspaceMountPolicyId}`,
    '--label',
    `geulbat.packageCacheMountPolicyId=${args.reuseKey.packageCacheMountPolicyId}`,
    '--label',
    `geulbat.packageCacheId=${args.reuseKey.packageCacheId}`,
    '--label',
    `geulbat.packageCacheIdentityHash=${args.reuseKey.packageCacheIdentityHash}`,
    '--label',
    `geulbat.idleEntrypointVersion=${args.reuseKey.idleEntrypointVersion}`,
    '--label',
    'geulbat.managerVersion=ptc-session-docker-v1',
    args.policy.imageRef,
    'node',
    '-e',
    "setInterval(() => {}, 60_000); process.on('SIGTERM', () => process.exit(0));",
  ];
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

    await preparePtcSessionDockerHostDirs({
      runtimeRoot: args.runtimeRoot,
      reuseKey,
    });
    const create = await runDocker(
      buildPtcSessionDockerCreateArgs({
        reuseKey,
        runtimeRoot: args.runtimeRoot,
        policy,
      }),
      signal,
    );
    if (!isSuccessfulExit(create)) {
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
      callbackRootHostPath: buildPtcSessionDockerCallbackRoot({
        runtimeRoot: args.runtimeRoot,
        reuseKey,
      }),
      callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
      artifactRootHostPath: buildPtcSessionDockerArtifactRoot({
        runtimeRoot: args.runtimeRoot,
        reuseKey,
      }),
      artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
      artifactWorkspaceMountPolicyId: reuseKey.artifactWorkspaceMountPolicyId,
      packageCacheRootHostPath: buildPtcPackageCacheRoot({
        runtimeRoot: args.runtimeRoot,
        identity: toPtcPackageCacheIdentity(reuseKey),
      }).hostPath,
      packageCacheRootContainerPath:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
      packageCacheId: reuseKey.packageCacheId,
      packageCacheIdentityHash: reuseKey.packageCacheIdentityHash,
    };
    sessions.set(reuseKey.identityHash, handle);
    return { ok: true, value: handle };
  }

  return {
    async getOrCreate(identity, options) {
      const reuseKey = await buildKey(identity);
      return await serializeForKey(reuseKey.identityHash, async () => {
        if (closingAll) {
          return {
            ok: false,
            reasonCode: 'manager_closing',
            message: 'PTC session Docker manager is closing',
          };
        }

        const current = sessions.get(reuseKey.identityHash);
        if (current) {
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
          const removed = await runDocker(
            ['rm', '-f', current.containerId],
            options?.signal,
          );
          if (!isSuccessfulExit(removed)) {
            return failure(
              'container_remove_failed',
              'failed to remove crashed PTC session container',
              removed,
            );
          }
          sessions.delete(reuseKey.identityHash);
          const cleanup = await removePtcSessionDockerHostRoot({
            runtimeRoot: args.runtimeRoot,
            reuseKey,
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
        const removed = await runDocker(
          ['rm', '-f', existing.containerId],
          options?.signal,
        );
        if (!isSuccessfulExit(removed)) {
          return failure(
            'container_remove_failed',
            'failed to remove PTC session container',
            removed,
          );
        }
        sessions.delete(reuseKey.identityHash);
        return await removePtcSessionDockerHostRoot({
          runtimeRoot: args.runtimeRoot,
          reuseKey,
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
              const removed = await runDocker(
                ['rm', '-f', current.containerId],
                options?.signal,
              );
              if (!isSuccessfulExit(removed)) {
                return failure(
                  'container_remove_failed',
                  'failed to remove PTC session container',
                  removed,
                );
              }
              sessions.delete(handle.reuseKey.identityHash);
              return await removePtcSessionDockerHostRoot({
                runtimeRoot: args.runtimeRoot,
                reuseKey: current.reuseKey,
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

export async function runPtcSessionDockerCommand(
  invocation: PtcSessionDockerCommandInvocation,
): Promise<PtcSessionDockerCommandResult> {
  if (invocation.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: 'docker command cancelled',
    };
  }

  return await new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: buildDockerClientEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let pendingTermination: 'timeout' | 'cancelled' | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: PtcSessionDockerCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      invocation.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const terminate = (kind: 'timeout' | 'cancelled'): void => {
      if (settled || pendingTermination) {
        return;
      }
      pendingTermination = kind;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKillTimer.unref?.();
    };

    const timer = setTimeout(() => terminate('timeout'), invocation.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => terminate('cancelled');
    invocation.signal?.addEventListener('abort', onAbort, { once: true });
    if (invocation.signal?.aborted) {
      terminate('cancelled');
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBoundedDockerOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedDockerOutput(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({ kind: 'crash', stdout, stderr: error.message });
    });
    child.on('close', (exitCode) => {
      if (pendingTermination) {
        finish({ kind: pendingTermination, stdout, stderr });
        return;
      }
      finish({ kind: 'exit', exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function appendBoundedDockerOutput(current: string, chunk: string): string {
  if (current.includes('[truncated]')) {
    return current;
  }
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= MAX_DOCKER_OUTPUT_BYTES) {
    return next;
  }
  return `${next.slice(0, MAX_DOCKER_OUTPUT_BYTES)}\n[truncated]`;
}

const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
] as const;

function buildDockerClientEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    ...Object.fromEntries(
      DOCKER_CLIENT_ENV_KEYS.flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
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

function sanitizeDockerDiagnostic(value: string): string {
  return value
    .replaceAll(
      /(?:[A-Za-z]:\\|\/)[^"' \n\r\t]*\.geulbat[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .replaceAll(/\/var\/run\/docker\.sock/gu, '[redacted:docker-socket]')
    .replaceAll(
      /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|\/mnt\/c\/Users\/|\/tmp\/|\/var\/folders\/)[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .slice(0, 512);
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
