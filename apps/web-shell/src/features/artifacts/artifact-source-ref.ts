import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type {
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import {
  sanitizeArtifactSourceInputRef,
  type ArtifactSourceInputRef,
  type ResolvedArtifactSourceRef,
} from './artifact-types.js';

export function buildTranscriptArtifactSourceRef(
  message: ThreadMessage,
  context: {
    projectId?: string | null;
    threadId?: string | null;
  },
): ArtifactSourceInputRef {
  const metadata = message.metadata;
  return {
    projectId: context.projectId ?? null,
    threadId: context.threadId ?? null,
    runId:
      metadata && typeof metadata.sourceRunId === 'string'
        ? metadata.sourceRunId
        : null,
    filePath:
      metadata && typeof metadata.sourceFile === 'string'
        ? metadata.sourceFile
        : null,
    messageTimestamp: message.timestamp,
  };
}

export function buildStreamingArtifactSourceRef(args: {
  projectId: string;
  threadId: string | null;
  runId: string | null;
  filePath: string | null;
}): ArtifactSourceInputRef {
  return {
    projectId: args.projectId,
    threadId: args.threadId,
    runId: args.runId,
    filePath: args.filePath,
  };
}

export function buildCommittedArtifactSourceRef(
  artifact: ThreadArtifactVersion,
): ArtifactSourceInputRef {
  return {
    kind: artifact.sourceRef?.kind ?? null,
    projectId: artifact.sourceRef?.projectId ?? null,
    threadId: artifact.sourceRef?.threadId ?? null,
    runId: artifact.sourceRef?.runId ?? null,
    filePath: artifact.sourceRef?.filePath ?? null,
    messageTimestamp: artifact.sourceRef?.messageTimestamp ?? null,
    artifactId: artifact.artifactId,
    artifactVersion: artifact.version,
    persistenceEpoch: artifact.persistenceEpoch,
  };
}

export function buildCanonicalArtifactSourceRef(
  sourceRef: ArtifactSourceInputRef | ResolvedArtifactSourceRef,
): ResolvedArtifactSourceRef {
  return sanitizeArtifactSourceInputRef(sourceRef);
}

export function deriveArtifactRuntimePersistenceScopeFromSourceRef(args: {
  renderer: ArtifactRuntimePersistenceRenderer;
  sourceRef: ArtifactSourceInputRef | ResolvedArtifactSourceRef;
}): ArtifactRuntimePersistenceScopeRequest | null {
  const sourceRef = buildCanonicalArtifactSourceRef(args.sourceRef);
  if (
    !sourceRef.projectId ||
    !sourceRef.threadId ||
    !sourceRef.artifactId ||
    sourceRef.persistenceEpoch === null
  ) {
    return null;
  }

  return {
    projectId: sourceRef.projectId,
    threadId: sourceRef.threadId,
    renderer: args.renderer,
    artifactId: sourceRef.artifactId,
    persistenceEpoch: sourceRef.persistenceEpoch,
  };
}
