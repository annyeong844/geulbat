import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  applyPtcHostPathMode,
  ptcHostPathModeDiagnostics,
} from './host-path-mode.js';
import { preparePtcPackageCacheRoot } from './lab-package-cache.js';
import type { PtcPackageCacheIdentity } from './lab-package-cache-contract.js';
import type {
  PtcSessionDockerResult,
  PtcSessionDockerReuseKey,
} from './session-docker-contract.js';

const PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT = 's';
const PTC_SESSION_DOCKER_HOST_CALLBACK_ROOT = 'c';
const PTC_SESSION_DOCKER_HOST_ARTIFACT_ROOT = 'a';
const PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS = 16;

export function buildPtcSessionDockerCallbackRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(
    buildPtcSessionDockerSessionRoot(args),
    PTC_SESSION_DOCKER_HOST_CALLBACK_ROOT,
  );
}

export function buildPtcSessionDockerSessionRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(
    args.runtimeRoot,
    PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT,
    args.reuseKey.identityHash.slice(
      0,
      PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS,
    ),
  );
}

export function buildPtcSessionDockerArtifactRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(
    buildPtcSessionDockerSessionRoot(args),
    PTC_SESSION_DOCKER_HOST_ARTIFACT_ROOT,
  );
}

export function toPtcPackageCacheIdentity(
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
  const sessionsRoot = join(
    args.runtimeRoot,
    PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT,
  );
  const sessionRoot = buildPtcSessionDockerSessionRoot(args);
  const callbackRoot = buildPtcSessionDockerCallbackRoot(args);
  const artifactRoot = buildPtcSessionDockerArtifactRoot(args);
  const packageCacheRoot = await preparePtcPackageCacheRoot({
    runtimeRoot: args.runtimeRoot,
    identity: toPtcPackageCacheIdentity(args.reuseKey),
  });
  await mkdir(sessionsRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: sessionsRoot,
    pathKind: 'ptc_sessions_root',
    mode: 0o700,
  });
  await mkdir(sessionRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: sessionRoot,
    pathKind: 'ptc_session_root',
    mode: 0o700,
  });
  await mkdir(callbackRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: callbackRoot,
    pathKind: 'ptc_session_callback_root',
    mode: 0o700,
  });
  await mkdir(artifactRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: artifactRoot,
    pathKind: 'ptc_session_artifact_root',
    mode: 0o700,
  });
  return {
    callbackRoot,
    artifactRoot,
    packageCacheRoot: packageCacheRoot.hostPath,
  };
}

export function ptcSessionDockerHostRootPrepareDiagnostics(
  error: unknown,
): Record<string, string | number | boolean> {
  return ptcHostPathModeDiagnostics(error);
}

export async function removePtcSessionDockerHostRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<PtcSessionDockerResult<void>> {
  try {
    await rm(buildPtcSessionDockerSessionRoot(args), {
      recursive: true,
      force: true,
    });
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      reasonCode: 'container_host_root_cleanup_failed',
      message: 'failed to clean PTC session host root',
      diagnostics: hostRootCleanupDiagnostics(error),
    };
  }
}

function hostRootCleanupDiagnostics(
  error: unknown,
): Record<string, string | number | boolean> {
  const diagnostics: Record<string, string | number | boolean> = {
    cleanupFailed: true,
  };
  if (error instanceof Error && error.name.length > 0) {
    diagnostics.cleanupErrorName = error.name;
  }
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === 'string' || typeof code === 'number') {
      diagnostics.cleanupErrorCode = code;
    }
  }
  return diagnostics;
}
