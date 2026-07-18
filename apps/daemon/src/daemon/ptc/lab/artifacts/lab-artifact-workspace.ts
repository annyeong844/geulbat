import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  rm,
  type FileHandle,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  SandboxAttemptOwner,
  SandboxAttemptStore,
} from '../../../sandbox/attempt-store.js';
import { importSandboxOutputEvidence } from '../../../sandbox/output-evidence-store.js';
import type { CollectedSandboxOutput } from '../../../sandbox/output-validation.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../packages/lab-package-cache-contract.js';
import type { PtcLabAdmittedProfile } from '../profile/lab-profile.js';
import { admitPtcLabPolicy, ptcFailure } from '../../shared/lab-spine.js';
import { sanitizePtcPrivateMarkers } from '../../shared/output-redaction.js';
import { hashPtcSha256Hex } from '../../shared/sha256.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
} from '../session/session-docker-contract.js';

export const PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

type PtcLabArtifactWorkspaceImportFailureReason =
  | 'ptc_lab_admission_required'
  | 'ptc_lab_artifact_workspace_disabled'
  | 'ptc_lab_artifact_policy_mismatch'
  | 'ptc_lab_artifact_workspace_unavailable'
  | 'ptc_lab_artifact_workspace_unsupported_platform'
  | 'ptc_lab_artifact_request_invalid'
  | 'ptc_lab_artifact_path_invalid'
  | 'ptc_lab_artifact_file_missing'
  | 'ptc_lab_artifact_file_too_large'
  | 'ptc_lab_artifact_file_unsupported'
  | 'ptc_lab_artifact_file_changed'
  | 'ptc_lab_artifact_import_failed';

type PtcLabArtifactWorkspaceImportResult<T> =
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

interface PtcLabArtifactWorkspaceImportRequest {
  relativePath: string;
  maxBytes?: number;
}

interface PtcLabArtifactWorkspaceImportSummary {
  profile: 'lab';
  policyId: string;
  workspaceId: string;
  exportPolicyId: string;
  artifactRelativePath: string;
  evidenceRef: string;
  files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  totalBytes: number;
}

interface ImportPtcLabArtifactWorkspaceFileArgs {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabArtifactWorkspaceSessionHandle | undefined;
  stateRoot: string;
  attemptStore: SandboxAttemptStore;
  request: PtcLabArtifactWorkspaceImportRequest;
  owner?: SandboxAttemptOwner;
  now?: () => string;
}

const failure = ptcFailure<PtcLabArtifactWorkspaceImportFailureReason>;
const PROC_SELF_FD_ROOT = '/proc/self/fd';
const FD_RELATIVE_ARTIFACT_IMPORT_PLATFORM = 'linux';

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

async function openArtifactFileWithoutSymlinkAncestors(args: {
  artifactRootHostPath: string;
  relativePath: string;
}): Promise<PtcLabArtifactWorkspaceImportResult<FileHandle>> {
  if (platform() !== FD_RELATIVE_ARTIFACT_IMPORT_PLATFORM) {
    return failure(
      'ptc_lab_artifact_workspace_unsupported_platform',
      'PTC lab artifact import is unsupported on this host platform',
    );
  }

  // O_NOFOLLOW is defense in depth: older Linux overlay combinations may
  // follow links. Match each lstat observation to the opened descriptor before
  // traversing it or reading bytes.
  const segments = args.relativePath.split('/');
  const finalSegment = segments.at(-1);
  if (finalSegment === undefined) {
    return failure(
      'ptc_lab_artifact_path_invalid',
      'PTC lab artifact import path is invalid',
    );
  }

  let currentDirectory: FileHandle | undefined;
  try {
    currentDirectory = await openArtifactDirectory(
      stripTrailingPathSeparators(args.artifactRootHostPath),
      'root',
    );

    for (const segment of segments.slice(0, -1)) {
      const previousDirectory = currentDirectory;
      const nextDirectory = await openArtifactDirectory(
        join(procSelfFdPath(previousDirectory.fd), segment),
        'ancestor',
      );
      currentDirectory = nextDirectory;
      await previousDirectory.close().catch(() => {});
    }

    const finalPath = join(procSelfFdPath(currentDirectory.fd), finalSegment);
    const expectedStats = await lstat(finalPath, { bigint: true });
    if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
      throw new PtcArtifactOpenError('ptc_lab_artifact_file_unsupported');
    }
    const file = await open(
      finalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const openedStats = await file.stat({ bigint: true });
      if (
        !openedStats.isFile() ||
        openedStats.dev !== expectedStats.dev ||
        openedStats.ino !== expectedStats.ino
      ) {
        throw new PtcArtifactOpenError('ptc_lab_artifact_file_changed');
      }
    } catch (error: unknown) {
      await file.close().catch(() => {});
      throw error;
    }

    return {
      ok: true,
      value: file,
    };
  } catch (error: unknown) {
    return artifactOpenFailure(error);
  } finally {
    await currentDirectory?.close().catch(() => {});
  }
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
  const opened = await openArtifactFileWithoutSymlinkAncestors({
    artifactRootHostPath: args.artifactRootHostPath,
    relativePath: args.relativePath,
  });
  if (!opened.ok) {
    return opened;
  }

  const handle = opened.value;
  let snapshotRoot: string | undefined;
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

    const sha256 = hashPtcSha256Hex(buffer);
    snapshotRoot = await mkdtemp(
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
  } catch {
    if (snapshotRoot !== undefined) {
      await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    }
    return failure(
      'ptc_lab_artifact_import_failed',
      'PTC lab artifact import failed',
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

function procSelfFdPath(fd: number): string {
  return join(PROC_SELF_FD_ROOT, String(fd));
}

function stripTrailingPathSeparators(path: string): string {
  let cursor = path;
  while (cursor.length > 1 && (cursor.endsWith('/') || cursor.endsWith('\\'))) {
    cursor = cursor.slice(0, -1);
  }
  return cursor;
}

async function openArtifactDirectory(
  path: string,
  position: 'root' | 'ancestor',
): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    const expectedStats = await lstat(path, { bigint: true });
    if (!expectedStats.isDirectory() || expectedStats.isSymbolicLink()) {
      throw new PtcArtifactOpenError('ptc_lab_artifact_file_unsupported');
    }
    directory = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const openedStats = await directory.stat({ bigint: true });
    if (
      !openedStats.isDirectory() ||
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino
    ) {
      throw new PtcArtifactOpenError('ptc_lab_artifact_file_changed');
    }
    return directory;
  } catch (error: unknown) {
    await directory?.close().catch(() => {});
    if (position === 'root' && isNodeErrorCode(error, 'ENOENT')) {
      throw new PtcArtifactOpenError('ptc_lab_artifact_workspace_unavailable');
    }
    throw error;
  }
}

function artifactOpenFailure(
  error: unknown,
): PtcLabArtifactWorkspaceImportResult<never> {
  if (error instanceof PtcArtifactOpenError) {
    if (error.reasonCode === 'ptc_lab_artifact_file_unsupported') {
      return failure(
        'ptc_lab_artifact_file_unsupported',
        'PTC lab artifact file is unsupported',
      );
    }
    if (error.reasonCode === 'ptc_lab_artifact_file_changed') {
      return failure(
        'ptc_lab_artifact_file_changed',
        'PTC lab artifact file changed during import',
      );
    }
    return failure(
      'ptc_lab_artifact_workspace_unavailable',
      'PTC lab artifact workspace is unavailable',
    );
  }
  if (isNodeErrorCode(error, 'ENOENT')) {
    return failure(
      'ptc_lab_artifact_file_missing',
      'PTC lab artifact file is missing',
    );
  }
  if (isNodeErrorCode(error, 'ELOOP') || isNodeErrorCode(error, 'ENOTDIR')) {
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

class PtcArtifactOpenError extends Error {
  constructor(
    readonly reasonCode: Extract<
      PtcLabArtifactWorkspaceImportFailureReason,
      | 'ptc_lab_artifact_workspace_unavailable'
      | 'ptc_lab_artifact_file_unsupported'
      | 'ptc_lab_artifact_file_changed'
    >,
  ) {
    super(reasonCode);
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
  // Inactive scaffold: no production caller owns this importer yet. Promote it
  // only with product owner/current-truth/config, or delete it if abandoned.
  const labPolicy = admitPtcLabPolicy(args.admission);
  if (!labPolicy.ok) {
    return failure(
      'ptc_lab_admission_required',
      'PTC lab artifact import requires an admitted lab profile',
    );
  }

  const artifactPolicy = labPolicy.value.mounts.artifactWorkspace;
  if (artifactPolicy.enabled !== true) {
    return failure(
      'ptc_lab_artifact_workspace_disabled',
      'PTC lab artifact workspace is disabled',
    );
  }

  if (
    args.session === undefined ||
    args.session.profile !== 'lab' ||
    args.session.policyId !== labPolicy.value.policyId ||
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
    rootPath: args.session.artifactRootContainerPath,
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
      workspaceRoot: args.stateRoot,
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
        policyId: labPolicy.value.policyId,
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
