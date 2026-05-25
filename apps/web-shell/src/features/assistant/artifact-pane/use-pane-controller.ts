import type { RunRequest } from '@geulbat/protocol/run-contract';

import { useArtifactPaneState } from './use-pane-state.js';
import type { ArtifactPaneViewModel } from '../../artifacts/artifact-pane-view-model.js';
import {
  buildArtifactPaneControllerProps,
  type ArtifactPaneControllerProps,
} from '../../artifacts/artifact-pane/controller-model.js';
import { useArtifactExportState } from '../../artifacts/export/use-artifact-export-state.js';

export interface UseArtifactPaneControllerArgs {
  label: string;
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  isLiveStreamingArtifact: boolean;
  onOpenSource?: (path: string) => Promise<void> | void;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}

export function useArtifactPaneController(
  args: UseArtifactPaneControllerArgs,
): ArtifactPaneControllerProps {
  const { label, viewModel, onOpenSource } = args;
  const exportState = useArtifactExportState({
    viewModel,
    isRunning: args.isRunning,
    ...(args.onStartArtifactRun !== undefined
      ? { onStartArtifactRun: args.onStartArtifactRun }
      : {}),
  });
  const paneState = useArtifactPaneState({
    ...args,
    onGeneratedTextExportSnapshotChange:
      exportState.onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange:
      exportState.onGeneratedBinaryExportSnapshotChange,
  });

  return buildArtifactPaneControllerProps({
    label,
    viewModel,
    paneState,
    exportState,
    ...(onOpenSource !== undefined ? { onOpenSource } : {}),
  });
}
