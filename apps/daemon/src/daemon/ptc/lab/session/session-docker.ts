import { access } from 'node:fs/promises';
import { hashPtcStableJson } from '../../shared/stable-identity.js';
import { isPtcRecord } from '../../shared/record-shape.js';
import { isPtcSha256Hex } from '../../shared/sha256.js';
import {
  cleanupPtcPackageCacheRootByHash,
  normalizePtcPackageCacheIdentity,
} from '../packages/lab-package-cache.js';
import {
  pickPtcPackageCacheIdentityInput,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
} from '../packages/lab-package-cache-contract.js';
import { toPtcLabNetworkIdentitySnapshot } from '../network/lab-network-policy.js';
import { toPtcLabBrowserIdentitySnapshot } from '../browser/core/lab-browser-identity.js';
import { sanitizePtcPrivateMarkers } from '../../shared/output-redaction.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import { buildPtcSessionDockerCreateArgs } from './session-docker-create-args.js';
import { ensurePtcOpenNetworkBridge } from './session-docker-open-network-bridge.js';
import {
  buildPtcSessionDockerRuntimeScopeHash,
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
} from './session-docker-contract.js';
import {
  buildPtcSessionDockerCallbackRoot,
  buildPtcSessionDockerSessionRoot,
  preparePtcSessionDockerHostDirs,
  ptcSessionDockerHostRootPrepareDiagnostics,
  removePtcSessionDockerHostRoot,
  removePtcSessionDockerHostRootByIdentityHash,
} from './session-docker-host-roots.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerHostUser,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
  PtcSessionDockerPolicy,
  PtcSessionDockerResult,
  PtcSessionDockerReuseKey,
} from './session-docker-contract.js';

type PtcSessionDockerFailureResult = Extract<
  PtcSessionDockerResult<never>,
  { ok: false }
>;

type PtcSessionDockerCommandExecutor = (
  dockerArgs: string[],
  signal?: AbortSignal,
) => Promise<PtcSessionDockerCommandResult>;

interface PtcSessionDockerTrackedState {
  runtimeRoot: string;
  runDocker: PtcSessionDockerCommandExecutor;
  sessions: Map<string, PtcSessionDockerHandle>;
  taintedSessionIdentityHashes: Set<string>;
}

export function normalizePtcSessionDockerReuseKey(args: {
  identity: PtcSessionDockerIdentity;
  stateRootRealpath: string;
  policy: PtcSessionDockerPolicy;
  hostUser?: PtcSessionDockerHostUser;
}): PtcSessionDockerReuseKey {
  const packageCacheIdentity = normalizePtcPackageCacheIdentity(
    pickPtcPackageCacheIdentityInput({
      trustContextId: args.identity.trustContextId,
      stateRootRealpath: args.stateRootRealpath,
      ...(args.identity.ephemeralBurstId === undefined
        ? {}
        : { ephemeralBurstId: args.identity.ephemeralBurstId }),
      labPolicyId: args.policy.labPolicyId,
      packageCacheId: args.policy.packageCacheId,
      packageCacheMountPolicyId: args.policy.packageCacheMountPolicyId,
      packageManagerFamilies: args.policy.packageManagerFamilies,
      lifecycleScriptsPolicyId: args.policy.lifecycleScriptsPolicyId,
      networkInstallPolicyId: args.policy.networkInstallPolicyId,
    }),
  );
  const base: Omit<PtcSessionDockerReuseKey, 'identityHash'> = {
    threadId: args.identity.threadId,
    stateRootRealpath: args.stateRootRealpath,
    trustContextId: args.identity.trustContextId,
    ...(args.identity.ephemeralBurstId === undefined
      ? {}
      : { ephemeralBurstId: args.identity.ephemeralBurstId }),
    ...(args.identity.sdkProjectionMount === undefined
      ? {}
      : { sdkProjectionMount: { ...args.identity.sdkProjectionMount } }),
    launchPolicyId: args.policy.launchPolicyId,
    imageRef: args.policy.imageRef,
    imagePolicyId: args.policy.imagePolicyId,
    idleEntrypointVersion: args.policy.idleEntrypointVersion,
    hostUser: args.hostUser ?? resolvePtcSessionDockerHostUser(),
    callbackMountPolicyId: args.policy.callbackMountPolicyId,
    artifactWorkspaceMountPolicyId: args.policy.artifactWorkspaceMountPolicyId,
    labPolicyId: args.policy.labPolicyId,
    packageCacheId: packageCacheIdentity.packageCacheId,
    packageCacheMountPolicyId: args.policy.packageCacheMountPolicyId,
    packageCacheRootContainerPath:
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    packageManagerFamilies: packageCacheIdentity.packageManagerFamilies,
    lifecycleScriptsPolicyId: args.policy.lifecycleScriptsPolicyId,
    networkInstallPolicyId: args.policy.networkInstallPolicyId,
    network: toPtcLabNetworkIdentitySnapshot(args.policy.network),
    browser: toPtcLabBrowserIdentitySnapshot(args.policy.browser),
    cpus: args.policy.cpus,
    memory: args.policy.memory,
    pidsLimit: args.policy.pidsLimit,
    scratchTmpfs: args.policy.scratchTmpfs,
    tmpTmpfs: args.policy.tmpTmpfs,
    packageCacheIdentityHash: packageCacheIdentity.cacheIdentityHash,
  };
  const identityHash = hashPtcStableJson({
    ...base,
    // A burst id owns one isolated, single-use container. Standby claim may
    // transfer that unopened slot to another thread, so the slot id replaces
    // the requesting thread only for ephemeral Docker reuse identity.
    threadId: base.ephemeralBurstId ?? base.threadId,
  });
  return { ...base, identityHash };
}

export function resolvePtcSessionDockerHostUser(): PtcSessionDockerHostUser {
  return {
    hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
    uid: readProcessId(process.getuid, 'uid'),
    gid: readProcessId(process.getgid, 'gid'),
  };
}

function readProcessId(
  reader: (() => number) | undefined,
  name: 'uid' | 'gid',
): number {
  if (typeof reader !== 'function') {
    throw new Error(`PTC session Docker host ${name} is unavailable`);
  }
  const value = reader();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`PTC session Docker host ${name} is invalid`);
  }
  return value;
}

export function createPtcSessionDockerManager(args: {
  runtimeRoot: string;
  dockerPath?: string;
  policy?: PtcSessionDockerPolicy;
  hostUser?: PtcSessionDockerHostUser;
  commandRunner?: PtcSessionDockerCommandRunner;
  realpathStateRoot(stateRoot: string): Promise<string>;
  timeoutMs?: number;
  reapEphemeralOnFirstUse?: boolean;
}): PtcSessionDockerManager {
  const executable = args.dockerPath ?? 'docker';
  const policy = args.policy ?? PTC_SESSION_DOCKER_DEFAULT_POLICY;
  const sessions = new Map<string, PtcSessionDockerHandle>();
  const taintedSessionIdentityHashes = new Set<string>();
  const operationQueues = new Map<string, Promise<void>>();
  let closingAll = false;
  let ephemeralStartupSweep: Promise<PtcSessionDockerResult<void>> | undefined;
  let restartResidueSweep: Promise<PtcSessionDockerResult<void>> | undefined;

  function ensureEphemeralStartupSweep(): Promise<
    PtcSessionDockerResult<void>
  > {
    if (args.reapEphemeralOnFirstUse !== true) {
      return Promise.resolve({ ok: true, value: undefined });
    }
    ephemeralStartupSweep ??= reapPtcSessionResidue({
      runtimeRoot: args.runtimeRoot,
      runDocker,
      scope: 'ephemeral',
    });
    return ephemeralStartupSweep;
  }

  function ensureRestartResidueSweep(): Promise<PtcSessionDockerResult<void>> {
    restartResidueSweep ??= reapPtcSessionResidue({
      runtimeRoot: args.runtimeRoot,
      runDocker,
      scope: 'all',
    });
    ephemeralStartupSweep ??= restartResidueSweep;
    return restartResidueSweep;
  }

  async function buildKey(
    identity: PtcSessionDockerIdentity,
  ): Promise<PtcSessionDockerReuseKey> {
    return normalizePtcSessionDockerReuseKey({
      identity,
      ...(args.hostUser === undefined ? {} : { hostUser: args.hostUser }),
      stateRootRealpath: await args.realpathStateRoot(identity.stateRoot),
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
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      ...(signal ? { signal } : {}),
    });
  }
  const trackedState: PtcSessionDockerTrackedState = {
    runtimeRoot: args.runtimeRoot,
    runDocker,
    sessions,
    taintedSessionIdentityHashes,
  };

  async function serializeForKey<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operationQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const queued = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (operationQueues.get(key) === queued) {
          operationQueues.delete(key);
        }
      });
    operationQueues.set(key, queued);
    return await next;
  }

  return {
    async reapRestartResidue() {
      return await ensureRestartResidueSweep();
    },
    async getOrCreate(identity, options) {
      const startupSweep = await ensureEphemeralStartupSweep();
      if (!startupSweep.ok) {
        return startupSweep;
      }
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
              trackedState,
              handle: current,
              removeFailureMessage:
                'failed to remove tainted PTC session container',
            });
            if (!cleanup.ok) {
              return cleanup;
            }
            return await startAndTrackSessionContainer({
              trackedState,
              policy,
              reuseKey,
              signal: options?.signal,
            });
          }
          const inspect = await runDocker(
            ['inspect', current.containerId],
            options?.signal,
          );
          const inspectReport = isSuccessfulExit(inspect)
            ? inspectRunningReport(inspect.stdout, current.containerId)
            : { running: false };
          if (isSuccessfulExit(inspect) && inspectReport.running) {
            return { ok: true, value: current };
          }
          const cleanup = await removeTrackedSessionContainerAndHostRoot({
            trackedState,
            handle: current,
            removeFailureMessage:
              'failed to remove crashed PTC session container',
          });
          if (!cleanup.ok) {
            return cleanup;
          }
        }
        if (taintedSessionIdentityHashes.has(reuseKey.identityHash)) {
          const cleanup = await removePtcSessionDockerOwnedHostRoots({
            runtimeRoot: trackedState.runtimeRoot,
            reuseKey,
          });
          if (!cleanup.ok) {
            return cleanup;
          }
          taintedSessionIdentityHashes.delete(reuseKey.identityHash);
        }

        return await startAndTrackSessionContainer({
          trackedState,
          policy,
          reuseKey,
          signal: options?.signal,
        });
      });
    },

    async close(identity, options) {
      const reuseKey = await buildKey(identity);
      return await serializeForKey(reuseKey.identityHash, async () => {
        return await closeTrackedSessionContainer({
          trackedState,
          reuseKey,
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
              return await closeTrackedSessionContainer({
                trackedState,
                reuseKey: handle.reuseKey,
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

async function startAndTrackSessionContainer(request: {
  trackedState: PtcSessionDockerTrackedState;
  policy: PtcSessionDockerPolicy;
  reuseKey: PtcSessionDockerReuseKey;
  signal: AbortSignal | undefined;
}): Promise<PtcSessionDockerResult<PtcSessionDockerHandle>> {
  const started = await startSessionContainer({
    runtimeRoot: request.trackedState.runtimeRoot,
    policy: request.policy,
    reuseKey: request.reuseKey,
    runDocker: request.trackedState.runDocker,
    signal: request.signal,
  });
  if (started.ok) {
    request.trackedState.sessions.set(
      request.reuseKey.identityHash,
      started.value,
    );
  }
  return started;
}

async function startSessionContainer(request: {
  runtimeRoot: string;
  policy: PtcSessionDockerPolicy;
  reuseKey: PtcSessionDockerReuseKey;
  runDocker: PtcSessionDockerCommandExecutor;
  signal: AbortSignal | undefined;
}): Promise<PtcSessionDockerResult<PtcSessionDockerHandle>> {
  const { runtimeRoot, policy, reuseKey, runDocker, signal } = request;
  const available = await checkDockerAvailable({
    imageRef: policy.imageRef,
    runDocker,
    signal,
  });
  if (!available.ok) {
    return available;
  }

  // Slice 1b: daemon-owned inspect/create/adopt of the named open egress bridge
  // for any open-network session launch (package install and browser lanes),
  // replacing the operator-provisioned manual prerequisite. Adoption of an
  // existing bridge is behavior-preserving; a missing bridge is now created
  // instead of failing closed.
  if (policy.network.mode === 'open') {
    const bridge = await ensurePtcOpenNetworkBridge({
      networkName: policy.network.dockerNetworkName,
      runDocker,
      ...(signal ? { signal } : {}),
    });
    if (!bridge.ok) {
      return bridge;
    }
  }

  const staleResidue = await cleanupUntrackedPtcSessionResidue({
    runtimeRoot,
    reuseKey,
    runDocker,
  });
  if (!staleResidue.ok) {
    return staleResidue;
  }

  let hostDirs: Awaited<ReturnType<typeof preparePtcSessionDockerHostDirs>>;
  try {
    hostDirs = await preparePtcSessionDockerHostDirs({
      runtimeRoot,
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
      runtimeRoot,
    }),
    signal,
  );
  if (!isSuccessfulExit(create)) {
    if (
      policy.network.mode === 'open' &&
      isOpenNetworkBackendUnavailable(create.stderr)
    ) {
      return await cleanupPreparedSessionFailure({
        runtimeRoot,
        reuseKey,
        primaryFailure: failure(
          'network_backend_unavailable',
          'PTC lab open egress Docker network is unavailable',
          create,
        ),
        runDocker,
      });
    }
    return await cleanupPreparedSessionFailure({
      runtimeRoot,
      reuseKey,
      primaryFailure: failure(
        'container_create_failed',
        'failed to create PTC session container',
        create,
      ),
      runDocker,
    });
  }

  const containerId = create.stdout.trim();
  if (!/^[A-Za-z0-9_.:-]+$/u.test(containerId)) {
    return await cleanupPreparedSessionFailure({
      runtimeRoot,
      reuseKey,
      primaryFailure: failure(
        'container_create_failed',
        'Docker create did not return a valid container id',
        create,
      ),
      runDocker,
    });
  }
  const start = await runDocker(['start', containerId], signal);
  if (!isSuccessfulExit(start)) {
    return await cleanupPreparedSessionFailure({
      runtimeRoot,
      reuseKey,
      containerId,
      containerRemoveFailureMessage:
        'failed to start PTC session container and cleanup failed',
      primaryFailure: failure(
        'container_start_failed',
        'failed to start PTC session container',
        start,
      ),
      runDocker,
    });
  }

  const inspect = await runDocker(['inspect', containerId], signal);
  const inspectReport = isSuccessfulExit(inspect)
    ? inspectRunningReport(inspect.stdout, containerId)
    : { running: false };
  if (!isSuccessfulExit(inspect) || !inspectReport.running) {
    return await cleanupPreparedSessionFailure({
      runtimeRoot,
      reuseKey,
      containerId,
      containerRemoveFailureMessage:
        'PTC session container inspect failed and cleanup failed',
      primaryFailure: failure(
        'container_inspect_failed',
        'PTC session container did not inspect as running',
        inspect,
        inspectReport.diagnostics,
      ),
      runDocker,
    });
  }

  return {
    ok: true,
    value: {
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
    },
  };
}

async function checkDockerAvailable(args: {
  imageRef: string;
  runDocker: PtcSessionDockerCommandExecutor;
  signal?: AbortSignal | undefined;
}): Promise<PtcSessionDockerResult<void>> {
  const version = await args.runDocker(['--version'], args.signal);
  if (!isSuccessfulExit(version)) {
    return failure('docker_unavailable', 'Docker is unavailable', version);
  }
  const image = await args.runDocker(
    ['image', 'inspect', args.imageRef],
    args.signal,
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

async function cleanupUntrackedPtcSessionResidue(request: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
  runDocker: PtcSessionDockerCommandExecutor;
}): Promise<PtcSessionDockerResult<void>> {
  const staleSessionRoot = await ptcSessionDockerSessionRootMayExist({
    runtimeRoot: request.runtimeRoot,
    reuseKey: request.reuseKey,
  });
  if (!staleSessionRoot) {
    return { ok: true, value: undefined };
  }

  const listed = await request.runDocker([
    'ps',
    '-a',
    '--filter',
    'label=geulbat.kind=ptc-session',
    '--filter',
    `label=geulbat.identityHash=${request.reuseKey.identityHash}`,
    '--format',
    '{{.ID}}',
  ]);
  if (!isSuccessfulExit(listed)) {
    return failure(
      'container_inspect_failed',
      'failed to inspect stale PTC session containers',
      listed,
    );
  }

  const containerIds = listed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (containerIds.length > 0) {
    const removed = await request.runDocker(['rm', '-f', ...containerIds]);
    if (!isSuccessfulExit(removed)) {
      return failure(
        'container_remove_failed',
        'failed to remove stale PTC session containers',
        removed,
      );
    }
  }

  return await removePtcSessionDockerOwnedHostRoots({
    runtimeRoot: request.runtimeRoot,
    reuseKey: request.reuseKey,
  });
}

async function reapPtcSessionResidue(request: {
  runtimeRoot: string;
  runDocker: PtcSessionDockerCommandExecutor;
  scope: 'all' | 'ephemeral';
}): Promise<PtcSessionDockerResult<void>> {
  const sweepFailureReason: PtcSessionDockerFailureReason =
    request.scope === 'ephemeral'
      ? 'ephemeral_startup_sweep_failed'
      : 'restart_residue_sweep_failed';
  const residueLabel =
    request.scope === 'ephemeral'
      ? 'ephemeral PTC session'
      : 'PTC restart residue';
  const runtimeScopeHash = buildPtcSessionDockerRuntimeScopeHash(
    request.runtimeRoot,
  );
  const listed = await request.runDocker([
    'ps',
    '-a',
    '--filter',
    'label=geulbat.kind=ptc-session',
    '--filter',
    'label=geulbat.owner=daemon',
    ...(request.scope === 'ephemeral'
      ? ['--filter', 'label=geulbat.ephemeral=true']
      : []),
    '--filter',
    `label=geulbat.runtimeScopeHash=${runtimeScopeHash}`,
    '--format',
    '{{.ID}}|{{.Label "geulbat.identityHash"}}|{{.Label "geulbat.packageCacheIdentityHash"}}|{{.Label "geulbat.ephemeral"}}',
  ]);
  if (!isSuccessfulExit(listed)) {
    return failure(
      sweepFailureReason,
      `failed to inspect ${residueLabel} containers`,
      listed,
    );
  }

  const records = listed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parsePtcSessionResidueRecord);
  if (
    records.some(
      (record) =>
        record === undefined ||
        (request.scope === 'ephemeral' && !record.ephemeral),
    )
  ) {
    return failureDiagnostics(
      sweepFailureReason,
      `${residueLabel} labels are invalid`,
      request.scope === 'ephemeral'
        ? { ephemeralLabelInvalid: true }
        : { restartResidueLabelInvalid: true },
    );
  }
  const validRecords = records.filter(
    (record): record is NonNullable<typeof record> => record !== undefined,
  );
  if (validRecords.length === 0) {
    return { ok: true, value: undefined };
  }

  const removed = await request.runDocker([
    'rm',
    '-f',
    ...validRecords.map((record) => record.containerId),
  ]);
  if (!isSuccessfulExit(removed)) {
    return failure(
      sweepFailureReason,
      `failed to remove ${residueLabel} containers`,
      removed,
    );
  }

  for (const record of validRecords) {
    const sessionRoot = await removePtcSessionDockerHostRootByIdentityHash({
      runtimeRoot: request.runtimeRoot,
      identityHash: record.identityHash,
    });
    if (!sessionRoot.ok) {
      return failureDiagnostics(
        sweepFailureReason,
        `failed to clean ${residueLabel} host root`,
        request.scope === 'ephemeral'
          ? { ephemeralSessionRootCleanupFailed: true }
          : { restartResidueSessionRootCleanupFailed: true },
      );
    }
    if (record.ephemeral) {
      const packageCache = await cleanupPtcPackageCacheRootByHash({
        runtimeRoot: request.runtimeRoot,
        cacheIdentityHash: record.packageCacheIdentityHash,
      });
      if (!packageCache.ok) {
        return failureDiagnostics(
          sweepFailureReason,
          'failed to clean ephemeral PTC package cache root',
          {
            ephemeralPackageCacheCleanupFailed: true,
            packageCacheReasonCode: packageCache.reasonCode,
          },
        );
      }
    }
  }
  return { ok: true, value: undefined };
}

function parsePtcSessionResidueRecord(line: string):
  | {
      containerId: string;
      identityHash: string;
      packageCacheIdentityHash: string;
      ephemeral: boolean;
    }
  | undefined {
  const [
    containerId,
    identityHash,
    packageCacheIdentityHash,
    ephemeralLabel,
    extra,
  ] = line.split('|');
  if (
    extra !== undefined ||
    containerId === undefined ||
    !/^[A-Za-z0-9_.:-]+$/u.test(containerId) ||
    identityHash === undefined ||
    !isPtcSha256Hex(identityHash) ||
    packageCacheIdentityHash === undefined ||
    !isPtcSha256Hex(packageCacheIdentityHash) ||
    (ephemeralLabel !== '' && ephemeralLabel !== 'true')
  ) {
    return undefined;
  }
  return {
    containerId,
    identityHash,
    packageCacheIdentityHash,
    ephemeral: ephemeralLabel === 'true',
  };
}

async function removePtcSessionDockerOwnedHostRoots(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<PtcSessionDockerResult<void>> {
  const sessionRoot = await removePtcSessionDockerHostRoot(args);
  if (!sessionRoot.ok || args.reuseKey.ephemeralBurstId === undefined) {
    return sessionRoot;
  }
  const packageCache = await cleanupPtcPackageCacheRootByHash({
    runtimeRoot: args.runtimeRoot,
    cacheIdentityHash: args.reuseKey.packageCacheIdentityHash,
  });
  if (!packageCache.ok) {
    return failureDiagnostics(
      'container_host_root_cleanup_failed',
      'failed to clean ephemeral PTC package cache root',
      {
        packageCacheCleanupFailed: true,
        packageCacheReasonCode: packageCache.reasonCode,
      },
    );
  }
  return sessionRoot;
}

async function ptcSessionDockerSessionRootMayExist(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<boolean> {
  for (const path of [
    buildPtcSessionDockerSessionRoot(args),
    buildPtcSessionDockerCallbackRoot(args),
  ]) {
    try {
      await access(path);
      return true;
    } catch (error: unknown) {
      if (!isPtcRecord(error) || error.code !== 'ENOENT') {
        return true;
      }
    }
  }
  return false;
}

async function cleanupPreparedSessionFailure(request: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
  primaryFailure: PtcSessionDockerFailureResult;
  runDocker: PtcSessionDockerCommandExecutor;
  containerId?: string;
  containerRemoveFailureMessage?: string;
}): Promise<PtcSessionDockerFailureResult> {
  if (request.containerId !== undefined) {
    const removed = await request.runDocker(['rm', '-f', request.containerId]);
    if (!isSuccessfulExit(removed)) {
      return failure(
        'container_start_cleanup_failed',
        request.containerRemoveFailureMessage ??
          'failed to cleanup PTC session startup container',
        removed,
      );
    }
  }

  const hostRoot = await removePtcSessionDockerOwnedHostRoots({
    runtimeRoot: request.runtimeRoot,
    reuseKey: request.reuseKey,
  });
  if (!hostRoot.ok) {
    return failureDiagnostics(
      'container_host_root_cleanup_failed',
      hostRoot.message,
      {
        ...(hostRoot.diagnostics ?? {}),
        startupReasonCode: request.primaryFailure.reasonCode,
      },
    );
  }

  return request.primaryFailure;
}

async function removeTrackedSessionContainerAndHostRoot(request: {
  trackedState: PtcSessionDockerTrackedState;
  handle: PtcSessionDockerHandle;
  removeFailureMessage: string;
}): Promise<PtcSessionDockerResult<void>> {
  const removed = await request.trackedState.runDocker([
    'rm',
    '-f',
    request.handle.containerId,
  ]);
  if (!isSuccessfulExit(removed)) {
    request.trackedState.taintedSessionIdentityHashes.add(
      request.handle.reuseKey.identityHash,
    );
    return failure(
      'container_remove_failed',
      request.removeFailureMessage,
      removed,
    );
  }
  request.trackedState.sessions.delete(request.handle.reuseKey.identityHash);
  const hostRoot = await removePtcSessionDockerOwnedHostRoots({
    runtimeRoot: request.trackedState.runtimeRoot,
    reuseKey: request.handle.reuseKey,
  });
  if (!hostRoot.ok) {
    request.trackedState.taintedSessionIdentityHashes.add(
      request.handle.reuseKey.identityHash,
    );
    return hostRoot;
  }
  request.trackedState.taintedSessionIdentityHashes.delete(
    request.handle.reuseKey.identityHash,
  );
  return hostRoot;
}

async function closeTrackedSessionContainer(request: {
  trackedState: PtcSessionDockerTrackedState;
  reuseKey: PtcSessionDockerReuseKey;
  signal: AbortSignal | undefined;
  removeFailureMessage: string;
}): Promise<PtcSessionDockerResult<void>> {
  const existing = request.trackedState.sessions.get(
    request.reuseKey.identityHash,
  );
  if (!existing) {
    if (request.reuseKey.ephemeralBurstId !== undefined) {
      const cleanup = await removePtcSessionDockerOwnedHostRoots({
        runtimeRoot: request.trackedState.runtimeRoot,
        reuseKey: request.reuseKey,
      });
      if (cleanup.ok) {
        request.trackedState.taintedSessionIdentityHashes.delete(
          request.reuseKey.identityHash,
        );
      }
      return cleanup;
    }
    return { ok: true, value: undefined };
  }
  return await removeTrackedSessionContainerAndHostRoot({
    trackedState: request.trackedState,
    handle: existing,
    removeFailureMessage: request.removeFailureMessage,
  });
}

function isSuccessfulExit(result: PtcSessionDockerCommandResult): boolean {
  return result.kind === 'exit' && result.exitCode === 0;
}

function failure(
  reasonCode: PtcSessionDockerFailureReason,
  message: string,
  result: PtcSessionDockerCommandResult,
  diagnostics?: Record<string, string | number | boolean>,
): PtcSessionDockerFailureResult {
  return {
    ok: false,
    reasonCode,
    message,
    diagnostics: {
      dockerResultKind: result.kind,
      stderr: sanitizeDockerDiagnostic(result.stderr),
      ...(diagnostics ?? {}),
    },
  };
}

function failureDiagnostics(
  reasonCode: PtcSessionDockerFailureReason,
  message: string,
  diagnostics: Record<string, string | number | boolean>,
): PtcSessionDockerFailureResult {
  return { ok: false, reasonCode, message, diagnostics };
}

function sanitizeDockerDiagnostic(value: string): string {
  return sanitizePtcPrivateMarkers(value).slice(0, 512);
}

interface PtcSessionDockerInspectRunningReport {
  running: boolean;
  diagnostics?: Record<string, string | number | boolean>;
}

function inspectRunningReport(
  stdout: string,
  containerId: string,
): PtcSessionDockerInspectRunningReport {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        running: false,
        diagnostics: { dockerInspectFailureKind: 'not_array' },
      };
    }
    const first: unknown = parsed[0];
    if (!isPtcRecord(first) || first.Id !== containerId) {
      return {
        running: false,
        diagnostics: { dockerInspectFailureKind: 'container_id_mismatch' },
      };
    }
    if (!isPtcRecord(first.State) || first.State.Running !== true) {
      return {
        running: false,
        diagnostics: { dockerInspectFailureKind: 'not_running' },
      };
    }
    return { running: true };
  } catch {
    return {
      running: false,
      diagnostics: { dockerInspectFailureKind: 'invalid_json' },
    };
  }
}

function isOpenNetworkBackendUnavailable(stderr: string): boolean {
  return /(?:network\s+\S+\s+not found|no such network|network .* unavailable)/iu.test(
    stderr,
  );
}
