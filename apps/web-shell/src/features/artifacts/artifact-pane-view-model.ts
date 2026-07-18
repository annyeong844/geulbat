import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ArtifactOnlyViewModel } from './artifact-types.js';
import { buildCommittedArtifactSourceRef } from './artifact-source-ref.js';
import { createCommittedArtifactViewModel } from './artifact-view-model.js';

export type ArtifactPaneViewModel = ArtifactOnlyViewModel;

export function createCommittedArtifactPaneViewModel(
  artifact: ThreadArtifactVersion,
): ArtifactPaneViewModel {
  return createCommittedArtifactViewModel({
    artifact,
    sourceRef: buildCommittedArtifactSourceRef(artifact),
  });
}

export function buildArtifactSessionKey(
  viewModel: ArtifactPaneViewModel,
): string {
  const { parsed, sourceRef } = viewModel;
  if (
    sourceRef.artifactId &&
    sourceRef.artifactVersion !== null &&
    sourceRef.artifactVersion !== undefined
  ) {
    return [
      parsed.renderer ?? '',
      sourceRef.artifactId,
      String(sourceRef.artifactVersion),
      String(sourceRef.persistenceEpoch ?? ''),
      parsed.state,
    ].join('::');
  }

  return [
    parsed.renderer ?? '',
    parsed.digest ?? '',
    parsed.state,
    sourceRef.workingDirectory,
    sourceRef.threadId ?? '',
    sourceRef.runId ?? '',
    sourceRef.filePath ?? '',
    sourceRef.messageTimestamp ?? '',
  ].join('::');
}
