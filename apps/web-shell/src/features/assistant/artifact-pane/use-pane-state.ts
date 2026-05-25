import type { RunRequest } from '@geulbat/protocol/run-contract';

import {
  buildArtifactSessionKey,
  type ArtifactPaneViewModel,
} from '../../artifacts/artifact-pane-view-model.js';
import { buildArtifactPaneStateModel } from '../../artifacts/artifact-pane/state-model.js';
import { useArtifactPaneTabState } from '../../artifacts/artifact-pane/use-artifact-pane-tab-state.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import type {
  ArtifactSurfaceStateBadge,
  ArtifactTab,
} from '../../artifacts/artifact-pane/types.js';
import { useArtifactPanePreviewSurface } from './use-pane-preview-surface.js';

interface UseArtifactPaneStateResult {
  tab: ArtifactTab;
  canShowPreview: boolean;
  showOpenSource: boolean;
  showApply: boolean;
  canApply: boolean;
  surfaceStateBadge: ArtifactSurfaceStateBadge | null;
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
  handleSelectTab: (tab: ArtifactTab) => void;
  handleApply: () => void;
}

export function useArtifactPaneState(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  isLiveStreamingArtifact: boolean;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): UseArtifactPaneStateResult {
  const {
    viewModel,
    isRunning,
    isLiveStreamingArtifact,
    onStartArtifactRun,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const artifactSessionKey = buildArtifactSessionKey(viewModel);
  const paneStateModel = buildArtifactPaneStateModel({
    viewModel,
    isRunning,
    hasStartArtifactRunHandler: onStartArtifactRun !== undefined,
  });
  const defaultTab = paneStateModel.defaultTab;

  const { tab, handleSelectTab } = useArtifactPaneTabState({
    artifactSessionKey,
    defaultTab,
  });

  const { previewSurface, runtimeUnavailableMessage } =
    useArtifactPanePreviewSurface({
      viewModel,
      artifactSessionKey,
      canShowPreview: paneStateModel.canShowPreview,
      supportsStreamingPreview: paneStateModel.supportsStreamingPreview,
      isLiveStreamingArtifact,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    });

  const handleApply = () => {
    if (paneStateModel.applyDraft) {
      void onStartArtifactRun?.(paneStateModel.applyDraft);
    }
  };

  return {
    tab,
    canShowPreview: paneStateModel.canShowPreview,
    showOpenSource: paneStateModel.showOpenSource,
    showApply: paneStateModel.showApply,
    canApply: paneStateModel.canApply,
    surfaceStateBadge: paneStateModel.surfaceStateBadge,
    previewSurface,
    runtimeUnavailableMessage,
    handleSelectTab,
    handleApply,
  };
}
