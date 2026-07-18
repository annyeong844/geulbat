import type { RunRequest } from '@geulbat/protocol/run-contract';

import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import { supportsStreamingArtifactPreview } from '../artifact-renderer-capabilities.js';
import { buildArtifactApplyRunDraftFromAuthority } from '../artifact-run-drafts.js';
import type { ArtifactSurfaceStateBadge, ArtifactTab } from './types.js';

interface ArtifactPaneStateModel {
  defaultTab: ArtifactTab;
  canShowPreview: boolean;
  supportsStreamingPreview: boolean;
  showApply: boolean;
  canApply: boolean;
  surfaceStateBadge: ArtifactSurfaceStateBadge | null;
  applyDraft: RunRequest | null;
}

export function buildArtifactPaneStateModel(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  hasStartArtifactRunHandler: boolean;
}): ArtifactPaneStateModel {
  const { viewModel } = args;
  const { parsed } = viewModel;
  const supportsStreamingPreview = supportsStreamingArtifactPreview(
    parsed.renderer,
  );
  const applyDraft = buildArtifactApplyRunDraftFromAuthority({
    parsed,
    sourceAuthority: viewModel.sourceAuthority,
  });
  const showApply = viewModel.actions.apply.visible;

  return {
    defaultTab: buildDefaultArtifactTab({
      parsed,
      supportsStreamingPreview,
    }),
    canShowPreview:
      parsed.state === 'completed' ||
      (parsed.state === 'streaming' && supportsStreamingPreview),
    supportsStreamingPreview,
    showApply,
    canApply:
      showApply &&
      !args.isRunning &&
      applyDraft !== null &&
      args.hasStartArtifactRunHandler,
    surfaceStateBadge: buildArtifactSurfaceStateBadge(parsed),
    applyDraft,
  };
}

function buildDefaultArtifactTab(args: {
  parsed: ArtifactPaneViewModel['parsed'];
  supportsStreamingPreview: boolean;
}): ArtifactTab {
  const { parsed } = args;
  if (parsed.state === 'completed') {
    return 'show';
  }
  if (parsed.state === 'streaming' && args.supportsStreamingPreview) {
    return 'show';
  }
  return 'source';
}

function buildArtifactSurfaceStateBadge(
  parsed: ArtifactPaneViewModel['parsed'],
): ArtifactSurfaceStateBadge | null {
  if (parsed.state === 'streaming') {
    return {
      label: '생성 중',
      tone: 'info',
    };
  }
  if (parsed.state === 'fallback') {
    return {
      label: '미리보기 제한',
      tone: 'warn',
    };
  }
  return null;
}
