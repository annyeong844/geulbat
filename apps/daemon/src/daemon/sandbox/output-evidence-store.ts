import { randomUUID } from 'node:crypto';
import { sha256Hex } from '@geulbat/content-identity/sha256';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';
import { isSameOrDescendantPath } from '../files/normalize-path.js';
import { isRecord } from '../runtime-json.js';
import {
  writeFileAtomically,
  writeTextFileAtomically,
} from '../utils/atomic-file.js';
import type {
  SandboxAttemptOwner,
  SandboxAttemptSnapshot,
  SandboxOutputFileRef,
  SandboxOutputRef,
} from './attempt-store.js';
import {
  isOpaqueSandboxOutputEvidenceRef,
  type CollectedSandboxOutput,
} from './output-validation.js';

const SANDBOX_OUTPUT_EVIDENCE_SCHEMA_VERSION = 1;

interface SandboxOutputEvidenceManifest {
  schemaVersion: typeof SANDBOX_OUTPUT_EVIDENCE_SCHEMA_VERSION;
  evidenceRef: string;
  jobId: string;
  attemptId: string;
  jobKind: string;
  adapterKind: string;
  owner: SandboxAttemptOwner;
  createdAt: string;
  files: readonly SandboxOutputFileRef[];
  totalBytes: number;
}

export class SandboxOutputEvidenceReadError extends Error {
  constructor(
    readonly reasonCode:
      | 'invalid_ref'
      | 'not_found'
      | 'invalid_evidence'
      | 'file_not_found',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxOutputEvidenceReadError';
  }
}

export interface OpenedSandboxOutputEvidenceFile {
  handle: FileHandle;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export async function importSandboxOutputEvidence(args: {
  workspaceRoot: string;
  attempt: Pick<
    SandboxAttemptSnapshot,
    'jobId' | 'attemptId' | 'jobKind' | 'adapterKind' | 'owner'
  >;
  collectedOutput: CollectedSandboxOutput;
  now?: () => string;
}): Promise<SandboxOutputRef> {
  const evidenceId = createSandboxOutputEvidenceId();
  const evidenceRef = buildSandboxOutputEvidenceRef({
    evidenceId,
  });
  const evidenceRoot = buildSandboxOutputEvidenceRoot({
    workspaceRoot: args.workspaceRoot,
    evidenceId,
  });
  const filesRoot = join(evidenceRoot, 'files');
  const files: SandboxOutputFileRef[] = [];
  let committed = false;
  let createdEvidenceRoot = false;

  try {
    await mkdir(dirname(evidenceRoot), { recursive: true });
    await mkdir(evidenceRoot, { recursive: false });
    createdEvidenceRoot = true;

    for (const file of args.collectedOutput.files) {
      assertSafeOutputRelativePath(file.relativePath);
      const sourcePath = join(args.collectedOutput.rootPath, file.relativePath);
      const sourceBuffer = await readValidatedSourceFile({
        collectedOutput: args.collectedOutput,
        file,
        sourcePath,
      });
      const targetPath = join(filesRoot, file.relativePath);

      await writeFileAtomically(targetPath, sourceBuffer);
      await assertCopiedFileDigest(targetPath, file);
      files.push({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }

    const manifest: SandboxOutputEvidenceManifest = {
      schemaVersion: SANDBOX_OUTPUT_EVIDENCE_SCHEMA_VERSION,
      evidenceRef,
      jobId: args.attempt.jobId,
      attemptId: args.attempt.attemptId,
      jobKind: args.attempt.jobKind,
      adapterKind: args.attempt.adapterKind,
      owner: { ...args.attempt.owner },
      createdAt: args.now?.() ?? new Date().toISOString(),
      files,
      totalBytes: args.collectedOutput.totalBytes,
    };

    await writeTextFileAtomically(
      join(evidenceRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    committed = true;

    return {
      evidenceRef,
      rootPath: filesRoot,
      files: files.map(({ relativePath, bytes, sha256 }) => ({
        relativePath,
        bytes,
        sha256,
      })),
      totalBytes: args.collectedOutput.totalBytes,
    };
  } finally {
    if (!committed && createdEvidenceRoot) {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }
}

export async function openSandboxOutputEvidenceFile(args: {
  workspaceRoot: string;
  evidenceRef: string;
  relativePath: string;
  expectedJobKind?: string;
}): Promise<OpenedSandboxOutputEvidenceFile> {
  if (!isOpaqueSandboxOutputEvidenceRef(args.evidenceRef)) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_ref',
      'sandbox output evidence reference is invalid',
    );
  }
  assertSafeOutputRelativePath(args.relativePath);

  let evidenceId: string;
  try {
    evidenceId = decodeURIComponent(
      args.evidenceRef.slice('sandbox-output:'.length),
    );
  } catch (error: unknown) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_ref',
      'sandbox output evidence reference is invalid',
      { cause: error },
    );
  }
  const evidenceRoot = buildSandboxOutputEvidenceRoot({
    workspaceRoot: args.workspaceRoot,
    evidenceId,
  });
  const sandboxOutputsRoot = joinWorkspaceGeulbatPath(
    args.workspaceRoot,
    'sandbox-outputs',
  );

  let realOutputsRoot: string;
  let realEvidenceRoot: string;
  let manifestRaw: string;
  try {
    [realOutputsRoot, realEvidenceRoot, manifestRaw] = await Promise.all([
      realpath(sandboxOutputsRoot),
      realpath(evidenceRoot),
      readFile(join(evidenceRoot, 'manifest.json'), 'utf8'),
    ]);
  } catch (error: unknown) {
    throw new SandboxOutputEvidenceReadError(
      'not_found',
      'sandbox output evidence was not found',
      { cause: error },
    );
  }
  if (!isSameOrDescendantPath(realOutputsRoot, realEvidenceRoot)) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence escaped its store',
    );
  }

  const manifest = parseSandboxOutputEvidenceManifest(manifestRaw);
  if (
    manifest.evidenceRef !== args.evidenceRef ||
    (args.expectedJobKind !== undefined &&
      manifest.jobKind !== args.expectedJobKind)
  ) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence manifest does not match the request',
    );
  }
  const file = manifest.files.find(
    (candidate) => candidate.relativePath === args.relativePath,
  );
  if (file === undefined) {
    throw new SandboxOutputEvidenceReadError(
      'file_not_found',
      'sandbox output evidence file was not found',
    );
  }

  const filesRoot = join(realEvidenceRoot, 'files');
  const targetPath = join(filesRoot, file.relativePath);
  let realFilesRoot: string;
  let realTargetPath: string;
  let expectedStats: BigIntStats;
  try {
    [realFilesRoot, realTargetPath, expectedStats] = await Promise.all([
      realpath(filesRoot),
      realpath(targetPath),
      lstat(targetPath, { bigint: true }),
    ]);
  } catch (error: unknown) {
    throw new SandboxOutputEvidenceReadError(
      'file_not_found',
      'sandbox output evidence file was not found',
      { cause: error },
    );
  }
  if (!isSameOrDescendantPath(realFilesRoot, realTargetPath)) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence file escaped its store',
    );
  }
  if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence file is unsupported',
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      targetPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      stats.dev !== expectedStats.dev ||
      stats.ino !== expectedStats.ino ||
      stats.size !== BigInt(file.bytes)
    ) {
      throw new SandboxOutputEvidenceReadError(
        'invalid_evidence',
        'sandbox output evidence file no longer matches its manifest',
      );
    }
    return {
      handle,
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  } catch (error: unknown) {
    await handle?.close().catch(() => {});
    if (error instanceof SandboxOutputEvidenceReadError) {
      throw error;
    }
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence file could not be opened',
      { cause: error },
    );
  }
}

function buildSandboxOutputEvidenceRef(args: { evidenceId: string }): string {
  return `sandbox-output:${encodeURIComponent(args.evidenceId)}`;
}

function buildSandboxOutputEvidenceRoot(args: {
  workspaceRoot: string;
  evidenceId: string;
}): string {
  return joinWorkspaceGeulbatPath(
    args.workspaceRoot,
    'sandbox-outputs',
    encodeURIComponent(args.evidenceId),
  );
}

function createSandboxOutputEvidenceId(): string {
  return `sandbox-evidence-${randomUUID()}`;
}

async function readValidatedSourceFile(args: {
  collectedOutput: CollectedSandboxOutput;
  file: SandboxOutputFileRef;
  sourcePath: string;
}): Promise<Buffer> {
  const displayPath = args.file.relativePath;
  const sourceRoot = await realpath(args.collectedOutput.rootPath);
  const realSourcePath = await realpath(args.sourcePath);

  if (!isSameOrDescendantPath(sourceRoot, realSourcePath)) {
    throw new Error(
      `sandbox output escapes sandbox output directory: ${displayPath}`,
    );
  }

  const sourceBuffer = await readFile(realSourcePath);
  if (sourceBuffer.byteLength !== args.file.bytes) {
    throw new Error(`sandbox output changed before import: ${displayPath}`);
  }
  const sha256 = sha256Hex(sourceBuffer);
  if (sha256 !== args.file.sha256) {
    throw new Error(`sandbox output changed before import: ${displayPath}`);
  }

  return sourceBuffer;
}

async function assertCopiedFileDigest(
  targetPath: string,
  file: SandboxOutputFileRef,
): Promise<void> {
  const targetBuffer = await readFile(targetPath);
  if (
    targetBuffer.byteLength !== file.bytes ||
    sha256Hex(targetBuffer) !== file.sha256
  ) {
    throw new Error(
      `sandbox output copy verification failed: ${file.relativePath}`,
    );
  }
}

function assertSafeOutputRelativePath(relativePath: string): void {
  const normalized = relativePath.split('\\').join('/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new Error(`invalid sandbox output relative path: ${relativePath}`);
  }
}

function parseSandboxOutputEvidenceManifest(
  raw: string,
): SandboxOutputEvidenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence manifest is not valid JSON',
      { cause: error },
    );
  }
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== SANDBOX_OUTPUT_EVIDENCE_SCHEMA_VERSION ||
    typeof parsed['evidenceRef'] !== 'string' ||
    typeof parsed['jobId'] !== 'string' ||
    typeof parsed['attemptId'] !== 'string' ||
    typeof parsed['jobKind'] !== 'string' ||
    typeof parsed['adapterKind'] !== 'string' ||
    !isRecord(parsed['owner']) ||
    typeof parsed['createdAt'] !== 'string' ||
    !Array.isArray(parsed['files']) ||
    !Number.isSafeInteger(parsed['totalBytes']) ||
    (parsed['totalBytes'] as number) < 0
  ) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence manifest is invalid',
    );
  }
  const files: SandboxOutputFileRef[] = [];
  for (const value of parsed['files']) {
    if (
      !isRecord(value) ||
      typeof value['relativePath'] !== 'string' ||
      !Number.isSafeInteger(value['bytes']) ||
      (value['bytes'] as number) < 0 ||
      typeof value['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value['sha256'])
    ) {
      throw new SandboxOutputEvidenceReadError(
        'invalid_evidence',
        'sandbox output evidence manifest file entry is invalid',
      );
    }
    try {
      assertSafeOutputRelativePath(value['relativePath']);
    } catch (error: unknown) {
      throw new SandboxOutputEvidenceReadError(
        'invalid_evidence',
        'sandbox output evidence manifest file path is invalid',
        { cause: error },
      );
    }
    files.push({
      relativePath: value['relativePath'],
      bytes: value['bytes'] as number,
      sha256: value['sha256'],
    });
  }
  const totalBytes = parsed['totalBytes'] as number;
  if (files.reduce((total, file) => total + file.bytes, 0) !== totalBytes) {
    throw new SandboxOutputEvidenceReadError(
      'invalid_evidence',
      'sandbox output evidence manifest total is invalid',
    );
  }
  const owner = parsed['owner'];
  return {
    schemaVersion: SANDBOX_OUTPUT_EVIDENCE_SCHEMA_VERSION,
    evidenceRef: parsed['evidenceRef'],
    jobId: parsed['jobId'],
    attemptId: parsed['attemptId'],
    jobKind: parsed['jobKind'],
    adapterKind: parsed['adapterKind'],
    owner: {
      ...(typeof owner['threadId'] === 'string'
        ? { threadId: owner['threadId'] }
        : {}),
      ...(typeof owner['runId'] === 'string' ? { runId: owner['runId'] } : {}),
    },
    createdAt: parsed['createdAt'],
    files,
    totalBytes,
  };
}
