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

// 같은 아티팩트의 더 새 버전이 커밋되어 있는지 — 채팅 카드는 최신 버전
// 하나만 남기고, 과거 버전 탐색은 중앙 창의 ← v{n} → 스테퍼가 맡는다.
export function hasNewerArtifactVersion(
  artifact: ThreadArtifactVersion,
  artifactsByRef: ArtifactsByRefMap,
): boolean {
  for (const candidate of artifactsByRef.values()) {
    if (
      candidate.artifactId === artifact.artifactId &&
      candidate.version > artifact.version
    ) {
      return true;
    }
  }
  return false;
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
