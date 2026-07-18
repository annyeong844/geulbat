import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type {
  ArtifactSourceInputRef,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import { buildCanonicalArtifactSourceRef } from '../../artifacts/artifact-source-ref.js';

const ARTIFACT_RUNTIME_REVISION_HASH_MASK = (1n << 64n) - 1n;
const ARTIFACT_RUNTIME_REVISION_HASH_PRIME = 1099511628211n;
const ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_A = 14695981039346656037n;
const ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_B = 7809847782465536322n;

export function createArtifactRuntimeSourceIdentity(
  sourceRef: ArtifactSourceInputRef | ResolvedArtifactSourceRef,
): string {
  const sanitizedSourceRef = buildCanonicalArtifactSourceRef(sourceRef);
  return JSON.stringify([
    sanitizedSourceRef.workingDirectory,
    sanitizedSourceRef.threadId,
    sanitizedSourceRef.runId,
    sanitizedSourceRef.filePath,
    sanitizedSourceRef.messageTimestamp,
    sanitizedSourceRef.artifactId,
    sanitizedSourceRef.artifactVersion,
    sanitizedSourceRef.persistenceEpoch,
  ]);
}

export function createArtifactRuntimeFrameRevision(args: {
  renderer: ArtifactRuntimePersistenceRenderer;
  runtimePayload: string;
  sourceIdentity?: string;
  persistenceScopeKey?: string | null;
  parentOrigin?: string;
}): string {
  const revisionParts = [
    args.renderer,
    '\u0000',
    args.sourceIdentity ?? '',
    '\u0000',
    args.persistenceScopeKey ?? '',
    '\u0000',
    args.parentOrigin ?? '',
    '\u0000',
    String(args.runtimePayload.length),
    '\u0000',
    args.runtimePayload,
  ] as const;

  let forwardHash = ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_A;
  let reverseHash = ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_B;
  let totalLength = 0;
  for (const part of revisionParts) {
    totalLength += part.length;
    forwardHash = mixArtifactRuntimeRevisionHash(forwardHash, part);
  }
  for (let index = revisionParts.length - 1; index >= 0; index -= 1) {
    const part = revisionParts[index];
    if (part === undefined) {
      continue;
    }
    reverseHash = mixArtifactRuntimeRevisionHashReverse(reverseHash, part);
  }

  return `rev2-${totalLength.toString(16)}-${formatArtifactRuntimeRevisionHash(forwardHash)}${formatArtifactRuntimeRevisionHash(reverseHash)}`;
}

function mixArtifactRuntimeRevisionHash(hash: bigint, value: string): bigint {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next ^= BigInt(value.charCodeAt(index));
    next =
      (next * ARTIFACT_RUNTIME_REVISION_HASH_PRIME) &
      ARTIFACT_RUNTIME_REVISION_HASH_MASK;
  }
  return next;
}

function mixArtifactRuntimeRevisionHashReverse(
  hash: bigint,
  value: string,
): bigint {
  let next = hash;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    next ^= BigInt(value.charCodeAt(index));
    next =
      (next * ARTIFACT_RUNTIME_REVISION_HASH_PRIME) &
      ARTIFACT_RUNTIME_REVISION_HASH_MASK;
  }
  return next;
}

function formatArtifactRuntimeRevisionHash(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}
