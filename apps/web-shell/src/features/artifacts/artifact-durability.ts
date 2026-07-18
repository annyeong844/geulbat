import {
  sanitizeGeneratedBinaryExportSnapshot,
  sanitizeGeneratedTextExportSnapshot,
  type ResolvedArtifactSourceRef,
  type GeneratedTextExportSnapshot,
  type GeneratedBinaryExportSnapshot,
} from './artifact-types.js';
import type { ArtifactDurabilitySourceAuthority } from './artifact-durability-source-authority.js';

const ARTIFACT_DURABILITY_HASH_MASK = (1n << 64n) - 1n;
const ARTIFACT_DURABILITY_HASH_PRIME = 1099511628211n;
const ARTIFACT_DURABILITY_HASH_OFFSET_A = 14695981039346656037n;
const ARTIFACT_DURABILITY_HASH_OFFSET_B = 7809847782465536322n;

export function resolveArtifactDurabilitySourceAuthorityFromResolved(args: {
  sourceRef?: ResolvedArtifactSourceRef;
  requireFilePath?: boolean;
}): ArtifactDurabilitySourceAuthority | null {
  const sourceRef = args.sourceRef;
  if (!sourceRef?.threadId || !sourceRef.runId || !sourceRef.messageTimestamp) {
    return null;
  }
  if (args.requireFilePath && !sourceRef.filePath) {
    return null;
  }

  return {
    workingDirectory: sourceRef.workingDirectory,
    threadId: sourceRef.threadId,
    runId: sourceRef.runId,
    messageTimestamp: sourceRef.messageTimestamp,
    filePath: sourceRef.filePath ?? null,
  };
}

export function createArtifactDurabilitySourceAuthorityKey(
  authority: ArtifactDurabilitySourceAuthority,
): string {
  return JSON.stringify([
    authority.workingDirectory,
    authority.threadId,
    authority.runId,
    authority.messageTimestamp,
    authority.filePath ?? '',
  ]);
}

export function createArtifactDurabilityIntentSnapshotId(args: {
  action:
    | 'apply_markdown'
    | 'export_markdown'
    | 'export_generated_text'
    | 'export_generated_binary';
  sourceAuthority: ArtifactDurabilitySourceAuthority;
  targetPath: string;
  artifactDigest?: string | null;
  artifactPayload?: string | null;
  snapshot?: GeneratedTextExportSnapshot | GeneratedBinaryExportSnapshot | null;
}): string {
  const targetPath = args.targetPath.trim();
  const fingerprint = readArtifactDurabilitySnapshotFingerprint(args);
  const parts = [
    args.action,
    '\u0000',
    createArtifactDurabilitySourceAuthorityKey(args.sourceAuthority),
    '\u0000',
    targetPath,
    '\u0000',
    args.artifactDigest ?? '',
    '\u0000',
    fingerprint,
  ] as const;

  let forwardHash = ARTIFACT_DURABILITY_HASH_OFFSET_A;
  let reverseHash = ARTIFACT_DURABILITY_HASH_OFFSET_B;
  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
    forwardHash = mixArtifactDurabilityHash(forwardHash, part);
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }
    reverseHash = mixArtifactDurabilityHashReverse(reverseHash, part);
  }

  return `intent-${totalLength.toString(16)}-${formatArtifactDurabilityHash(forwardHash)}${formatArtifactDurabilityHash(reverseHash)}`;
}

function readArtifactDurabilitySnapshotFingerprint(args: {
  action:
    | 'apply_markdown'
    | 'export_markdown'
    | 'export_generated_text'
    | 'export_generated_binary';
  artifactPayload?: string | null;
  snapshot?: GeneratedTextExportSnapshot | GeneratedBinaryExportSnapshot | null;
}): string {
  if (args.action === 'apply_markdown' || args.action === 'export_markdown') {
    const payload =
      typeof args.artifactPayload === 'string' ? args.artifactPayload : '';
    return JSON.stringify([
      'artifact',
      payload.length,
      hashArtifactDurabilityText(payload),
    ]);
  }

  const textSnapshot = sanitizeGeneratedTextExportSnapshot(args.snapshot);
  if (textSnapshot) {
    return JSON.stringify([
      'generated_text',
      textSnapshot.mimeType,
      textSnapshot.fileNameHint ?? '',
      textSnapshot.content.length,
      hashArtifactDurabilityText(textSnapshot.content),
    ]);
  }

  const binarySnapshot = sanitizeGeneratedBinaryExportSnapshot(args.snapshot);
  if (binarySnapshot) {
    return JSON.stringify([
      'generated_binary',
      binarySnapshot.blob.type,
      binarySnapshot.fileNameHint ?? '',
      binarySnapshot.blob.size,
    ]);
  }

  return 'unknown';
}

function hashArtifactDurabilityText(value: string): string {
  let hash = ARTIFACT_DURABILITY_HASH_OFFSET_A;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash =
      (hash * ARTIFACT_DURABILITY_HASH_PRIME) & ARTIFACT_DURABILITY_HASH_MASK;
  }
  return formatArtifactDurabilityHash(hash);
}

function mixArtifactDurabilityHash(hash: bigint, value: string): bigint {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next ^= BigInt(value.charCodeAt(index));
    next =
      (next * ARTIFACT_DURABILITY_HASH_PRIME) & ARTIFACT_DURABILITY_HASH_MASK;
  }
  return next;
}

function mixArtifactDurabilityHashReverse(hash: bigint, value: string): bigint {
  let next = hash;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    next ^= BigInt(value.charCodeAt(index));
    next =
      (next * ARTIFACT_DURABILITY_HASH_PRIME) & ARTIFACT_DURABILITY_HASH_MASK;
  }
  return next;
}

function formatArtifactDurabilityHash(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}
