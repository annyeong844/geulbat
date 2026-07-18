import type { RunRequest } from '@geulbat/protocol/run-contract';

import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import {
  buildArtifactPaneControllerProps,
  type ArtifactPaneControllerProps,
} from './controller-model.js';
import { useArtifactPaneState } from './use-artifact-pane-state.js';
import { useArtifactExportState } from '../export/use-artifact-export-state.js';
import type { RenderArtifactRuntimeFrame } from '../runtime-preview/types.js';

export interface UseArtifactPaneControllerArgs {
  label: string;
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  isLiveStreamingArtifact: boolean;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}

export function useArtifactPaneController(
  args: UseArtifactPaneControllerArgs,
): ArtifactPaneControllerProps {
  const { label, viewModel } = args;
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
  });
}
