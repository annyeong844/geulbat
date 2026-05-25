import {
  createArtifactRefKey,
  type ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import {
  readActiveArtifactRefFromMetadata,
  readArtifactRefsFromMetadata,
} from '@geulbat/protocol/thread-metadata';
import type { ThreadMessage } from '@geulbat/protocol/threads';

export type ArtifactsByRefMap = ReadonlyMap<string, ThreadArtifactVersion>;

export function createArtifactsByRefMap(
  artifacts: readonly ThreadArtifactVersion[],
): ArtifactsByRefMap {
  return new Map(
    artifacts.map(
      (artifact) =>
        [
          createArtifactRefKey({
            artifactId: artifact.artifactId,
            version: artifact.version,
          }),
          artifact,
        ] as const,
    ),
  );
}

export function readCommittedMessageArtifact(
  message: ThreadMessage,
  artifactsByRef: ArtifactsByRefMap,
): ThreadArtifactVersion | null {
  if (message.role !== 'assistant') {
    return null;
  }

  const activeRef = readActiveArtifactRefFromMetadata(message.metadata);
  if (activeRef) {
    return artifactsByRef.get(createArtifactRefKey(activeRef)) ?? null;
  }

  for (const ref of readArtifactRefsFromMetadata(message.metadata)) {
    const artifact = artifactsByRef.get(createArtifactRefKey(ref));
    if (artifact) {
      return artifact;
    }
  }

  return null;
}
