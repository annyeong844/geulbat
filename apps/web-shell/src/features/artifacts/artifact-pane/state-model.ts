import type { RunRequest } from '@geulbat/protocol/run-contract';

import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import { buildArtifactApplyRunDraftFromAuthority } from '../artifact-run-drafts.js';
import type { ArtifactTab } from './types.js';

interface ArtifactPaneStateModel {
  defaultTab: ArtifactTab;
  showApply: boolean;
  canApply: boolean;
  applyDraft: RunRequest | null;
}

export function buildArtifactPaneStateModel(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  hasStartArtifactRunHandler: boolean;
}): ArtifactPaneStateModel {
  const { viewModel } = args;
  const applyDraft = buildArtifactApplyRunDraftFromAuthority({
    artifact: viewModel.artifact,
    sourceAuthority: viewModel.sourceAuthority,
  });
  const showApply = viewModel.actions.apply.visible;

  return {
    defaultTab: 'show',
    showApply,
    canApply:
      showApply &&
      !args.isRunning &&
      applyDraft !== null &&
      args.hasStartArtifactRunHandler,
    applyDraft,
  };
}
