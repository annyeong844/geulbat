import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';
import { isPathInsideWorkspaceBoundary } from '../files/normalize-path.js';
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
import type { CollectedSandboxOutput } from './output-validation.js';

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

export function buildSandboxOutputEvidenceRef(args: {
  evidenceId: string;
}): string {
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

  if (!isPathInsideWorkspaceBoundary(sourceRoot, realSourcePath)) {
    throw new Error(
      `sandbox output escapes sandbox output directory: ${displayPath}`,
    );
  }

  const sourceBuffer = await readFile(realSourcePath);
  if (sourceBuffer.byteLength !== args.file.bytes) {
    throw new Error(`sandbox output changed before import: ${displayPath}`);
  }
  const sha256 = createHash('sha256').update(sourceBuffer).digest('hex');
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
    createHash('sha256').update(targetBuffer).digest('hex') !== file.sha256
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
