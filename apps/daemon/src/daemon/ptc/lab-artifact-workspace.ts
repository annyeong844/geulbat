import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type {
  SandboxAttemptOwner,
  SandboxAttemptStore,
} from '../sandbox/attempt-store.js';
import { importSandboxOutputEvidence } from '../sandbox/output-evidence-store.js';
import type { CollectedSandboxOutput } from '../sandbox/output-validation.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import { sanitizePtcPrivateMarkers } from './output-redaction.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
} from './session-docker-contract.js';

export const PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

export type PtcLabArtifactWorkspaceImportFailureReason =
  | 'ptc_lab_admission_required'
  | 'ptc_lab_artifact_workspace_disabled'
  | 'ptc_lab_artifact_policy_mismatch'
  | 'ptc_lab_artifact_workspace_unavailable'
  | 'ptc_lab_artifact_request_invalid'
  | 'ptc_lab_artifact_path_invalid'
  | 'ptc_lab_artifact_file_missing'
  | 'ptc_lab_artifact_file_too_large'
  | 'ptc_lab_artifact_file_unsupported'
  | 'ptc_lab_artifact_file_changed'
  | 'ptc_lab_artifact_digest_mismatch'
  | 'ptc_lab_artifact_quota_exceeded'
  | 'ptc_lab_artifact_import_failed';

export type PtcLabArtifactWorkspaceImportResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabArtifactWorkspaceImportFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabArtifactWorkspaceSessionHandle {
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  artifactRootHostPath: string;
  artifactRootContainerPath: typeof PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT;
  artifactWorkspaceMountPolicyId: string;
}

export interface PtcLabArtifactWorkspaceImportRequest {
  relativePath: string;
  maxBytes?: number;
}

export interface PtcLabArtifactWorkspaceImportSummary {
  profile: 'lab';
  policyId: string;
  workspaceId: string;
  exportPolicyId: string;
  artifactRelativePath: string;
  evidenceRef: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  totalBytes: number;
}

export interface ImportPtcLabArtifactWorkspaceFileArgs {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabArtifactWorkspaceSessionHandle | undefined;
  workspaceRoot: string;
  attemptStore: SandboxAttemptStore;
  request: PtcLabArtifactWorkspaceImportRequest;
  owner?: SandboxAttemptOwner;
  now?: () => string;
}

function failure(
  reasonCode: PtcLabArtifactWorkspaceImportFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabArtifactWorkspaceImportResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}

function sanitizeDiagnosticValue(value: string): string {
  return sanitizePtcPrivateMarkers(value).slice(0, 512);
}

function validateRelativePath(
  relativePath: string,
): PtcLabArtifactWorkspaceImportResult<string> {
  if (typeof relativePath !== 'string') {
    return failure(
      'ptc_lab_artifact_path_invalid',
      'PTC lab artifact import path is invalid',
    );
  }

  const segments = relativePath.split('/');
  if (
    relativePath.trim().length === 0 ||
    relativePath.includes('\0') ||
    relativePath.startsWith('/') ||
    relativePath.startsWith(`${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT}/`) ||
    relativePath.startsWith(
      `${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}/`,
    ) ||
    relativePath.includes('\\') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    ) ||
    segments.some(
      (segment) => segment === '.geulbat' || segment === 'node_modules',
    )
  ) {
    return failure(
      'ptc_lab_artifact_path_invalid',
      'PTC lab artifact import path is invalid',
    );
  }

  return { ok: true, value: segments.join('/') };
}

function validateMaxBytes(
  value: number | undefined,
): PtcLabArtifactWorkspaceImportResult<number> {
  if (value === undefined) {
    return { ok: true, value: PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES };
  }
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES
  ) {
    return failure(
      'ptc_lab_artifact_request_invalid',
      'PTC lab artifact import byte limit is invalid',
    );
  }
  return { ok: true, value };
}

async function validateArtifactPathAncestors(args: {
  artifactRootHostPath: string;
  relativePath: string;
}): Promise<PtcLabArtifactWorkspaceImportResult<void>> {
  const sourcePath = join(args.artifactRootHostPath, args.relativePath);
  let rootRealpath: string;
  try {
    rootRealpath = await realpath(args.artifactRootHostPath);
  } catch {
    return failure(
      'ptc_lab_artifact_workspace_unavailable',
      'PTC lab artifact workspace is unavailable',
    );
  }

  let currentPath = args.artifactRootHostPath;
  for (const segment of args.relativePath.split('/').slice(0, -1)) {
    currentPath = join(currentPath, segment);
    try {
      const stat = await lstat(currentPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return failure(
          'ptc_lab_artifact_file_unsupported',
          'PTC lab artifact file is unsupported',
        );
      }
    } catch (error: unknown) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return failure(
          'ptc_lab_artifact_file_missing',
          'PTC lab artifact file is missing',
        );
      }
      if (isNodeErrorCode(error, 'ELOOP')) {
        return failure(
          'ptc_lab_artifact_file_unsupported',
          'PTC lab artifact file is unsupported',
        );
      }
      return failure(
        'ptc_lab_artifact_workspace_unavailable',
        'PTC lab artifact workspace is unavailable',
      );
    }
  }

  try {
    const parentRealpath = await realpath(dirname(sourcePath));
    if (
      parentRealpath !== rootRealpath &&
      !parentRealpath.startsWith(`${rootRealpath}${sep}`)
    ) {
      return failure(
        'ptc_lab_artifact_path_invalid',
        'PTC lab artifact import path is invalid',
      );
    }
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return failure(
        'ptc_lab_artifact_file_missing',
        'PTC lab artifact file is missing',
      );
    }
    if (isNodeErrorCode(error, 'ELOOP')) {
      return failure(
        'ptc_lab_artifact_file_unsupported',
        'PTC lab artifact file is unsupported',
      );
    }
    return failure(
      'ptc_lab_artifact_workspace_unavailable',
      'PTC lab artifact workspace is unavailable',
    );
  }

  return { ok: true, value: undefined };
}

async function snapshotArtifactFile(args: {
  artifactRootHostPath: string;
  relativePath: string;
  maxBytes: number;
}): Promise<
  PtcLabArtifactWorkspaceImportResult<{
    snapshotRoot: string;
    collectedOutput: CollectedSandboxOutput;
  }>
> {
  const sourcePath = join(args.artifactRootHostPath, args.relativePath);
  const ancestors = await validateArtifactPathAncestors({
    artifactRootHostPath: args.artifactRootHostPath,
    relativePath: args.relativePath,
  });
  if (!ancestors.ok) {
    return ancestors;
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return failure(
        'ptc_lab_artifact_file_missing',
        'PTC lab artifact file is missing',
      );
    }
    if (isNodeErrorCode(error, 'ELOOP')) {
      return failure(
        'ptc_lab_artifact_file_unsupported',
        'PTC lab artifact file is unsupported',
      );
    }
    return failure(
      'ptc_lab_artifact_workspace_unavailable',
      'PTC lab artifact workspace is unavailable',
    );
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      return failure(
        'ptc_lab_artifact_file_unsupported',
        'PTC lab artifact file is unsupported',
      );
    }
    if (before.size > args.maxBytes) {
      return failure(
        'ptc_lab_artifact_file_too_large',
        'PTC lab artifact file exceeds byte limit',
      );
    }

    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return failure(
        'ptc_lab_artifact_file_changed',
        'PTC lab artifact file changed during import',
      );
    }
    if (buffer.byteLength > args.maxBytes) {
      return failure(
        'ptc_lab_artifact_file_too_large',
        'PTC lab artifact file exceeds byte limit',
      );
    }

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const snapshotRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-artifact-import-'),
    );
    const snapshotPath = join(snapshotRoot, args.relativePath);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, buffer);

    return {
      ok: true,
      value: {
        snapshotRoot,
        collectedOutput: {
          rootPath: snapshotRoot,
          files: [
            {
              relativePath: args.relativePath,
              bytes: buffer.byteLength,
              sha256,
            },
          ],
          totalBytes: buffer.byteLength,
        },
      },
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function importPtcLabArtifactWorkspaceFile(
  args: ImportPtcLabArtifactWorkspaceFileArgs,
): Promise<
  PtcLabArtifactWorkspaceImportResult<PtcLabArtifactWorkspaceImportSummary>
> {
  if (
    args.admission === undefined ||
    args.admission.metadata.selectedProfile !== 'lab' ||
    args.admission.labPolicy === undefined
  ) {
    return failure(
      'ptc_lab_admission_required',
      'PTC lab artifact import requires an admitted lab profile',
    );
  }

  const artifactPolicy = args.admission.labPolicy.mounts.artifactWorkspace;
  if (artifactPolicy.enabled !== true) {
    return failure(
      'ptc_lab_artifact_workspace_disabled',
      'PTC lab artifact workspace is disabled',
    );
  }

  if (
    args.session === undefined ||
    args.session.profile !== 'lab' ||
    args.session.policyId !== args.admission.labPolicy.policyId ||
    args.session.artifactRootContainerPath !==
      PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT ||
    args.session.artifactWorkspaceMountPolicyId !==
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID ||
    isPackageCacheLikeHostPath(args.session.artifactRootHostPath)
  ) {
    return failure(
      'ptc_lab_artifact_policy_mismatch',
      'PTC lab artifact workspace session does not match admitted policy',
    );
  }

  const relativePath = validateRelativePath(args.request.relativePath);
  if (!relativePath.ok) {
    return relativePath;
  }
  const maxBytes = validateMaxBytes(args.request.maxBytes);
  if (!maxBytes.ok) {
    return maxBytes;
  }

  const attempt = args.attemptStore.createAttempt({
    jobKind: 'ptc_lab_artifact_workspace_import',
    adapterKind: 'ptc_lab_artifact_workspace',
    ...(args.owner ? { owner: args.owner } : {}),
    capability: {
      schemaVersion: 1,
      capabilityId: 'ptc_lab_artifact_workspace_import_v1',
      capabilityClass: 'candidate_generation',
      executionClass: 'sandbox_job',
      commitBehavior: 'candidate_only',
      policies: {
        workspaceId: artifactPolicy.workspaceId,
        exportPolicyId: artifactPolicy.exportPolicyId,
        artifactWorkspaceMountPolicyId:
          args.session.artifactWorkspaceMountPolicyId,
        maxBytes: maxBytes.value,
      },
    },
  });
  args.attemptStore.markRunning(attempt.attemptId, {
    rootPath: args.session.artifactRootHostPath,
  });

  const snapshot = await snapshotArtifactFile({
    artifactRootHostPath: args.session.artifactRootHostPath,
    relativePath: relativePath.value,
    maxBytes: maxBytes.value,
  });
  if (!snapshot.ok) {
    args.attemptStore.markTerminal(attempt.attemptId, {
      status: 'failed',
      diagnostics: snapshot.reasonCode,
    });
    return snapshot;
  }

  try {
    const outputRef = await importSandboxOutputEvidence({
      workspaceRoot: args.workspaceRoot,
      attempt,
      collectedOutput: snapshot.value.collectedOutput,
      ...(args.now ? { now: args.now } : {}),
    });
    args.attemptStore.markTerminal(attempt.attemptId, {
      status: 'succeeded',
      outputRef,
    });

    return {
      ok: true,
      value: {
        profile: 'lab',
        policyId: args.admission.labPolicy.policyId,
        workspaceId: artifactPolicy.workspaceId,
        exportPolicyId: artifactPolicy.exportPolicyId,
        artifactRelativePath: relativePath.value,
        evidenceRef: outputRef.evidenceRef,
        files: outputRef.files.map((file) => ({ ...file })),
        totalBytes: outputRef.totalBytes,
      },
    };
  } catch (error: unknown) {
    args.attemptStore.markTerminal(attempt.attemptId, {
      status: 'failed',
      diagnostics: 'ptc_lab_artifact_import_failed',
    });
    return failure(
      'ptc_lab_artifact_import_failed',
      'PTC lab artifact import failed',
      error instanceof Error
        ? { error: sanitizeDiagnosticValue(error.message) }
        : undefined,
    );
  } finally {
    await rm(snapshot.value.snapshotRoot, { recursive: true, force: true });
  }
}

function isPackageCacheLikeHostPath(value: string): boolean {
  return (
    value.includes('/ptc-package-caches/') ||
    value.includes('\\ptc-package-caches\\') ||
    value.includes('/geulbat/package-cache') ||
    value.includes('\\geulbat\\package-cache')
  );
}
