import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isPtcRecord } from '../../shared/record-shape.js';
import { isPtcSha256Hex } from '../../shared/sha256.js';
import {
  applyPtcHostPathMode,
  ptcHostPathModeDiagnostics,
} from './host-path-mode.js';
import { pickPtcPackageCacheIdentityInput } from '../packages/lab-package-cache-contract.js';
import { preparePtcPackageCacheRoot } from '../packages/lab-package-cache-root.js';
import type { PtcPackageCacheIdentity } from '../packages/lab-package-cache-contract.js';
import { buildPtcSessionDockerRuntimeScopeHash } from './session-docker-contract.js';
import type {
  PtcSessionDockerResult,
  PtcSessionDockerReuseKey,
} from './session-docker-contract.js';

const PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT = 's';
const PTC_SESSION_DOCKER_HOST_CALLBACK_ROOT = 'c';
const PTC_SESSION_DOCKER_HOST_ARTIFACT_ROOT = 'a';
const PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS = 16;
const PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE = 0o700;
const PTC_SESSION_DOCKER_CALLBACK_RUNTIME_PARENT = '/tmp';
const PTC_SESSION_DOCKER_CALLBACK_RUNTIME_OWNER_PREFIX = 'geulbat-ptc-';

export function buildPtcSessionDockerCallbackRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return join(
    buildPtcSessionDockerCallbackSessionRoot({
      runtimeRoot: args.runtimeRoot,
      identityHash: args.reuseKey.identityHash,
    }),
    PTC_SESSION_DOCKER_HOST_CALLBACK_ROOT,
  );
}

export function buildPtcSessionDockerSessionRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return buildPtcSessionDockerSessionRootByIdentityHash({
    runtimeRoot: args.runtimeRoot,
    identityHash: args.reuseKey.identityHash,
  });
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
    ...pickPtcPackageCacheIdentityInput(reuseKey),
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
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
  await mkdir(sessionRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: sessionRoot,
    pathKind: 'ptc_session_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
  await preparePtcSessionDockerCallbackRuntimeRoot(args);
  await mkdir(artifactRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: artifactRoot,
    pathKind: 'ptc_session_artifact_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
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
  return await removePtcSessionDockerHostRootByIdentityHash({
    runtimeRoot: args.runtimeRoot,
    identityHash: args.reuseKey.identityHash,
  });
}

export async function removePtcSessionDockerHostRootByIdentityHash(args: {
  runtimeRoot: string;
  identityHash: string;
}): Promise<PtcSessionDockerResult<void>> {
  if (!isPtcSha256Hex(args.identityHash)) {
    return {
      ok: false,
      reasonCode: 'container_host_root_cleanup_failed',
      message: 'failed to clean PTC session host root',
      diagnostics: { cleanupFailed: true, identityHashInvalid: true },
    };
  }
  try {
    const sessionRoot = buildPtcSessionDockerSessionRootByIdentityHash(args);
    const callbackSessionRoot = buildPtcSessionDockerCallbackSessionRoot(args);
    if (process.platform !== 'win32') {
      await preparePtcSessionDockerCallbackRuntimeOwnerRoot();
    }
    await rm(sessionRoot, { recursive: true, force: true });
    if (callbackSessionRoot !== sessionRoot) {
      await rm(callbackSessionRoot, { recursive: true, force: true });
    }
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

function buildPtcSessionDockerSessionRootByIdentityHash(args: {
  runtimeRoot: string;
  identityHash: string;
}): string {
  return join(
    args.runtimeRoot,
    PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT,
    args.identityHash.slice(0, PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS),
  );
}

function buildPtcSessionDockerCallbackSessionRoot(args: {
  runtimeRoot: string;
  identityHash: string;
}): string {
  if (process.platform === 'win32') {
    return buildPtcSessionDockerSessionRootByIdentityHash(args);
  }
  return join(
    buildPtcSessionDockerCallbackRuntimeOwnerRoot(),
    PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT,
    buildPtcSessionDockerRuntimeScopeHash(args.runtimeRoot).slice(
      0,
      PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS,
    ),
    args.identityHash.slice(0, PTC_SESSION_DOCKER_HOST_IDENTITY_HASH_CHARS),
  );
}

async function preparePtcSessionDockerCallbackRuntimeRoot(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): Promise<void> {
  const callbackRoot = buildPtcSessionDockerCallbackRoot(args);
  const callbackSessionRoot = buildPtcSessionDockerCallbackSessionRoot({
    runtimeRoot: args.runtimeRoot,
    identityHash: args.reuseKey.identityHash,
  });
  const callbackRuntimeScopeRoot = dirname(callbackSessionRoot);
  const callbackSessionsRoot = join(
    process.platform === 'win32'
      ? args.runtimeRoot
      : buildPtcSessionDockerCallbackRuntimeOwnerRoot(),
    PTC_SESSION_DOCKER_HOST_SESSIONS_ROOT,
  );
  if (process.platform !== 'win32') {
    await preparePtcSessionDockerCallbackRuntimeOwnerRoot();
  }
  await mkdir(callbackSessionsRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: callbackSessionsRoot,
    pathKind: 'ptc_callback_sessions_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
  await mkdir(callbackRuntimeScopeRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: callbackRuntimeScopeRoot,
    pathKind: 'ptc_callback_runtime_scope_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
  await mkdir(callbackSessionRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: callbackSessionRoot,
    pathKind: 'ptc_callback_session_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
  await mkdir(callbackRoot, { recursive: true });
  await applyPtcHostPathMode({
    path: callbackRoot,
    pathKind: 'ptc_session_callback_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
}

async function preparePtcSessionDockerCallbackRuntimeOwnerRoot(): Promise<void> {
  const ownerRoot = buildPtcSessionDockerCallbackRuntimeOwnerRoot();
  try {
    await mkdir(ownerRoot, {
      mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
      recursive: false,
    });
  } catch (error: unknown) {
    if (!isPtcRecord(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
  const stats = await lstat(ownerRoot);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== readPtcSessionDockerProcessUid()
  ) {
    throw new Error(
      'PTC callback runtime owner root is not a private directory',
    );
  }
  await applyPtcHostPathMode({
    path: ownerRoot,
    pathKind: 'ptc_callback_runtime_owner_root',
    mode: PTC_SESSION_DOCKER_HOST_DIRECTORY_MODE,
  });
}

function buildPtcSessionDockerCallbackRuntimeOwnerRoot(): string {
  return join(
    PTC_SESSION_DOCKER_CALLBACK_RUNTIME_PARENT,
    `${PTC_SESSION_DOCKER_CALLBACK_RUNTIME_OWNER_PREFIX}${readPtcSessionDockerProcessUid()}`,
  );
}

function readPtcSessionDockerProcessUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('PTC callback runtime requires a POSIX process uid');
  }
  return uid;
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
  if (isPtcRecord(error)) {
    const code = error.code;
    if (typeof code === 'string' || typeof code === 'number') {
      diagnostics.cleanupErrorCode = code;
    }
  }
  return diagnostics;
}
