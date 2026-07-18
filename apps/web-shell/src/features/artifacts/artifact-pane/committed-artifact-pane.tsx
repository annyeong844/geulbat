import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
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
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}

type ArtifactPaneProps = Omit<UseArtifactPaneControllerArgs, 'viewModel'>;

export function CommittedArtifactPane(props: CommittedArtifactPaneProps) {
  const { label, artifact, isRunning, renderRuntimeFrame, onStartArtifactRun } =
    props;
  const viewModel = createCommittedArtifactPaneViewModel(artifact);

  return (
    <ArtifactPane
      label={label}
      viewModel={viewModel}
      isRunning={isRunning}
      isLiveStreamingArtifact={false}
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
