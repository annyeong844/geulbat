import type { RunRequest } from '@geulbat/protocol/run-contract';

import {
  buildArtifactSessionKey,
  type ArtifactPaneViewModel,
} from '../artifact-pane-view-model.js';
import { buildArtifactPaneStateModel } from './state-model.js';
import { useArtifactPaneTabState } from './use-artifact-pane-tab-state.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../artifact-types.js';
import type { ArtifactTab } from './types.js';
import { useArtifactPanePreviewSurface } from './use-artifact-pane-preview-surface.js';
import type { RenderArtifactRuntimeFrame } from '../runtime-preview/types.js';

interface UseArtifactPaneStateResult {
  tab: ArtifactTab;
  showApply: boolean;
  canApply: boolean;
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
  handleSelectTab: (tab: ArtifactTab) => void;
  handleApply: () => void;
}

export function useArtifactPaneState(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
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
    renderRuntimeFrame,
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
      renderRuntimeFrame,
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
    showApply: paneStateModel.showApply,
    canApply: paneStateModel.canApply,
    previewSurface,
    runtimeUnavailableMessage,
    handleSelectTab,
    handleApply,
  };
}
