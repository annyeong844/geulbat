import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { ArtifactViewModel } from './artifact-types.js';
import { buildCommittedArtifactSourceRef } from './artifact-source-ref.js';
import { createCommittedArtifactViewModel } from './artifact-view-model.js';

export type ArtifactPaneViewModel = ArtifactViewModel;

export function createCommittedArtifactPaneViewModel(
  artifact: ThreadArtifactVersion,
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null,
): ArtifactPaneViewModel {
  return createCommittedArtifactViewModel({
    artifact,
    sourceRef: buildCommittedArtifactSourceRef(artifact),
    ...(planningWorkflowSnapshot === undefined
      ? {}
      : { planningWorkflowSnapshot }),
  });
}

export function buildArtifactSessionKey(
  viewModel: ArtifactPaneViewModel,
): string {
  return [
    viewModel.artifact.renderer,
    viewModel.artifact.artifactId,
    String(viewModel.artifact.version),
    String(viewModel.artifact.persistenceEpoch),
  ].join('::');
}
