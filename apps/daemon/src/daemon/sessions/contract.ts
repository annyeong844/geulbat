import {
  createArtifactRefKey as createProtocolArtifactRefKey,
  isArtifactRecord as isProtocolArtifactRecord,
  isArtifactVersionRecord as isProtocolArtifactVersionRecord,
  normalizeArtifactSourceRef as normalizeProtocolArtifactSourceRef,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactRenderer,
  type ArtifactRunId,
  type ArtifactSourceRef,
  type ArtifactVersionRecord,
  type ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import {
  assertRunId as assertProtocolRunId,
  assertThreadId as assertProtocolThreadId,
  isThreadId as isProtocolThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  readActiveArtifactRefFromMetadata as readProtocolActiveArtifactRefFromMetadata,
  readArtifactRefsFromMetadata as readProtocolArtifactRefsFromMetadata,
} from '@geulbat/protocol/thread-metadata';
import {
  isThreadMessage as isProtocolThreadMessage,
  type ThreadDetailResponse,
  type ThreadMessage,
  type ThreadMessageInput,
  type ThreadSummary,
} from '@geulbat/protocol/threads';
export type {
  ArtifactId,
  ArtifactRecord,
  ArtifactRef,
  ArtifactRenderer,
  ArtifactRunId,
  ArtifactSourceRef,
  ArtifactVersionRecord,
  RunId,
  ThreadArtifactVersion,
  ThreadDetailResponse,
  ThreadId,
  ThreadMessage,
  ThreadMessageInput,
  ThreadSummary,
};

export function assertSessionRunId(runId: string): RunId {
  return assertProtocolRunId(runId);
}

export function assertSessionThreadId(threadId: string): ThreadId {
  return assertProtocolThreadId(threadId);
}

export function isSessionThreadId(threadId: string): threadId is ThreadId {
  return isProtocolThreadId(threadId);
}

export function isSessionThreadMessage(value: unknown): value is ThreadMessage {
  return isProtocolThreadMessage(value);
}

export function createSessionArtifactRefKey(ref: ArtifactRef): string {
  return createProtocolArtifactRefKey(ref);
}

export function normalizeSessionArtifactSourceRef(
  value: unknown,
): ArtifactSourceRef | null {
  return normalizeProtocolArtifactSourceRef(value);
}

export function isSessionArtifactRecord(
  value: unknown,
): value is ArtifactRecord {
  return isProtocolArtifactRecord(value);
}

export function isSessionArtifactVersionRecord(
  value: unknown,
): value is ArtifactVersionRecord {
  return isProtocolArtifactVersionRecord(value);
}

export function readSessionArtifactRefsFromMetadata(
  metadata: ThreadMessage['metadata'],
): ArtifactRef[] {
  return readProtocolArtifactRefsFromMetadata(metadata);
}

export function readSessionActiveArtifactRefFromMetadata(
  metadata: ThreadMessage['metadata'],
): ArtifactRef | null {
  return readProtocolActiveArtifactRefFromMetadata(metadata);
}
