import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type {
  ArtifactSourceInputRef,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import { buildCanonicalArtifactSourceRef } from '../../artifacts/artifact-source-ref.js';

interface ArtifactRuntimeRevisionHash {
  high: number;
  low: number;
}

const UINT32_RANGE = 0x1_0000_0000;
// FNV-1a 64-bit prime 0x00000100_000001b3, split into uint32 words.
const ARTIFACT_RUNTIME_REVISION_HASH_PRIME_HIGH = 0x0000_0100;
const ARTIFACT_RUNTIME_REVISION_HASH_PRIME_LOW = 0x0000_01b3;
const ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_A = {
  high: 0xcbf2_9ce4,
  low: 0x8422_2325,
} satisfies ArtifactRuntimeRevisionHash;
const ARTIFACT_RUNTIME_REVISION_HASH_OFFSET_B = {
  high: 0x6c62_272e,
  low: 0x07bb_0142,
} satisfies ArtifactRuntimeRevisionHash;
const ARTIFACT_RUNTIME_REVISION_HASH_WORD_HEX_LENGTH = 8;

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

function mixArtifactRuntimeRevisionHash(
  hash: ArtifactRuntimeRevisionHash,
  value: string,
): ArtifactRuntimeRevisionHash {
  let high = hash.high;
  let low = hash.low;
  for (let index = 0; index < value.length; index += 1) {
    low = (low ^ value.charCodeAt(index)) >>> 0;
    const lowProduct = low * ARTIFACT_RUNTIME_REVISION_HASH_PRIME_LOW;
    const carry = Math.floor(lowProduct / UINT32_RANGE);
    high =
      (Math.imul(high, ARTIFACT_RUNTIME_REVISION_HASH_PRIME_LOW) +
        Math.imul(low, ARTIFACT_RUNTIME_REVISION_HASH_PRIME_HIGH) +
        carry) >>>
      0;
    low = lowProduct >>> 0;
  }
  return { high, low };
}

function mixArtifactRuntimeRevisionHashReverse(
  hash: ArtifactRuntimeRevisionHash,
  value: string,
): ArtifactRuntimeRevisionHash {
  let high = hash.high;
  let low = hash.low;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    low = (low ^ value.charCodeAt(index)) >>> 0;
    const lowProduct = low * ARTIFACT_RUNTIME_REVISION_HASH_PRIME_LOW;
    const carry = Math.floor(lowProduct / UINT32_RANGE);
    high =
      (Math.imul(high, ARTIFACT_RUNTIME_REVISION_HASH_PRIME_LOW) +
        Math.imul(low, ARTIFACT_RUNTIME_REVISION_HASH_PRIME_HIGH) +
        carry) >>>
      0;
    low = lowProduct >>> 0;
  }
  return { high, low };
}

function formatArtifactRuntimeRevisionHash(
  hash: ArtifactRuntimeRevisionHash,
): string {
  return `${hash.high
    .toString(16)
    .padStart(ARTIFACT_RUNTIME_REVISION_HASH_WORD_HEX_LENGTH, '0')}${hash.low
    .toString(16)
    .padStart(ARTIFACT_RUNTIME_REVISION_HASH_WORD_HEX_LENGTH, '0')}`;
}
