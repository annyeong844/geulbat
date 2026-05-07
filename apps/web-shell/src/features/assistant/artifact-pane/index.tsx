import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { createCommittedArtifactPaneViewModel } from '../../artifacts/artifact-pane-view-model.js';
import { ArtifactPaneView } from '../../artifacts/artifact-pane/view.js';
import {
  useArtifactPaneController,
  type UseArtifactPaneControllerArgs,
} from './use-pane-controller.js';

export function CommittedArtifactMessage(props: {
  label: string;
  artifact: ThreadArtifactVersion;
  isRunning: boolean;
  onOpenSource?: (path: string) => Promise<void> | void;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}) {
  const { label, artifact, isRunning, onOpenSource, onStartArtifactRun } =
    props;
  const viewModel = createCommittedArtifactPaneViewModel(artifact);

  return (
    <ArtifactPane
      label={label}
      viewModel={viewModel}
      isRunning={isRunning}
      isLiveStreamingArtifact={false}
      {...(onOpenSource !== undefined ? { onOpenSource } : {})}
      {...(onStartArtifactRun !== undefined ? { onStartArtifactRun } : {})}
    />
  );
}

function ArtifactPane(props: UseArtifactPaneControllerArgs) {
  const controllerProps = useArtifactPaneController(props);

  return <ArtifactPaneView {...controllerProps} />;
}
