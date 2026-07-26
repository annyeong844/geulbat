import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { createCommittedArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type { RenderArtifactRuntimeFrame } from '../runtime-preview/types.js';
import {
  useArtifactPaneController,
  type UseArtifactPaneControllerArgs,
} from './use-artifact-pane-controller.js';
import { ArtifactPaneView } from './view.js';

interface CommittedArtifactPaneProps {
  label: string;
  artifact: ThreadArtifactVersion;
  isRunning: boolean;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}

type ArtifactPaneProps = Omit<UseArtifactPaneControllerArgs, 'viewModel'>;

export function CommittedArtifactPane(props: CommittedArtifactPaneProps) {
  const {
    label,
    artifact,
    isRunning,
    renderRuntimeFrame,
    planningWorkflowSnapshot,
    onStartArtifactRun,
  } = props;
  const viewModel = createCommittedArtifactPaneViewModel(
    artifact,
    planningWorkflowSnapshot,
  );

  return (
    <ArtifactPane
      label={label}
      viewModel={viewModel}
      isRunning={isRunning}
      renderRuntimeFrame={renderRuntimeFrame}
      {...(onStartArtifactRun !== undefined ? { onStartArtifactRun } : {})}
    />
  );
}

function ArtifactPane(
  props: ArtifactPaneProps & {
    viewModel: UseArtifactPaneControllerArgs['viewModel'];
  },
) {
  const controllerProps = useArtifactPaneController(props);

  return <ArtifactPaneView {...controllerProps} />;
}
