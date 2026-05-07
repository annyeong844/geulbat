import type { RunRequest } from '@geulbat/protocol/run-contract';

import {
  buildArtifactExportRunDraftFromAuthority,
  buildGeneratedTextExportRunDraftFromAuthority,
  canBuildGeneratedBinaryExportFromAuthority,
  canBuildGeneratedTextExportRunFromAuthority,
  deriveGeneratedBinaryExportTargetPathHint,
  deriveGeneratedTextExportTargetPathHint,
} from '../artifact-run-drafts.js';
import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import {
  supportsGeneratedBinaryExportSnapshot,
  supportsGeneratedTextExportSnapshot,
} from '../artifact-renderer-capabilities.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../artifact-types.js';

type ArtifactExportMode =
  | 'static'
  | 'generated_text'
  | 'generated_binary'
  | null;

interface ArtifactExportModel {
  exportMode: ArtifactExportMode;
  showExport: boolean;
  canOpenExport: boolean;
  canSubmitExport: boolean;
  exportPlaceholder: string;
  exportHint: string;
  exportDraft: RunRequest | null;
}

export function deriveArtifactExportModel(args: {
  viewModel: ArtifactPaneViewModel;
  isRunning: boolean;
  targetPath: string;
  generatedTextExportSnapshot: GeneratedTextExportSnapshot | null;
  generatedBinaryExportSnapshot: GeneratedBinaryExportSnapshot | null;
  generatedBinaryExportPending: boolean;
  canOfferRememberedBinaryOverwrite: boolean;
  hasStartArtifactRun: boolean;
}): ArtifactExportModel {
  const {
    viewModel,
    isRunning,
    targetPath,
    generatedTextExportSnapshot,
    generatedBinaryExportSnapshot,
    generatedBinaryExportPending,
    canOfferRememberedBinaryOverwrite,
    hasStartArtifactRun,
  } = args;
  const parsed = viewModel.parsed;
  const trimmedTargetPath = targetPath.trim();
  const sourceAuthority = viewModel.sourceAuthority;
  const staticExportVisible = viewModel.actions.export.visible;
  const supportsGeneratedBinaryExport = supportsGeneratedBinaryExportSnapshot(
    parsed.renderer,
  );
  const supportsGeneratedTextExport = supportsGeneratedTextExportSnapshot(
    parsed.renderer,
  );
  const runtimeBinaryExportVisible =
    supportsGeneratedBinaryExport &&
    parsed.state === 'completed' &&
    canBuildGeneratedBinaryExportFromAuthority({
      snapshot: generatedBinaryExportSnapshot,
      sourceAuthority,
    });
  const runtimeTextExportVisible =
    supportsGeneratedTextExport &&
    parsed.state === 'completed' &&
    canBuildGeneratedTextExportRunFromAuthority({
      snapshot: generatedTextExportSnapshot,
      sourceAuthority,
    });
  const exportMode = staticExportVisible
    ? 'static'
    : runtimeBinaryExportVisible
      ? 'generated_binary'
      : runtimeTextExportVisible
        ? 'generated_text'
        : null;
  const showExport = exportMode !== null;
  const exportDraft = createArtifactExportDraft({
    exportMode,
    viewModel,
    sourceAuthority,
    targetPath,
    generatedTextExportSnapshot,
  });
  const canOpenBinaryExport =
    exportMode === 'generated_binary' &&
    !isRunning &&
    !generatedBinaryExportPending &&
    sourceAuthority !== null;
  const canOpenExport =
    showExport &&
    (canOpenBinaryExport ||
      (!isRunning && exportMode !== 'generated_binary' && hasStartArtifactRun));
  const canSubmitExport =
    exportMode === 'generated_binary'
      ? canOpenBinaryExport && trimmedTargetPath.length > 0
      : showExport && !isRunning && exportDraft !== null && hasStartArtifactRun;
  const exportPlaceholder =
    exportMode === 'static' && viewModel.sourceRef.filePath
      ? `exports/${viewModel.sourceRef.filePath.split('/').pop()}`
      : exportMode === 'static'
        ? 'exports/artifact-preview.md'
        : exportMode === 'generated_binary'
          ? deriveGeneratedBinaryExportTargetPathHint({
              snapshot: generatedBinaryExportSnapshot,
            })
          : deriveGeneratedTextExportTargetPathHint({
              snapshot: generatedTextExportSnapshot,
            });
  const exportHint =
    exportMode === 'generated_binary'
      ? canOfferRememberedBinaryOverwrite
        ? 'Export keeps create-only as the default path. Enable overwrite explicitly to replace the previously exported file at the same path.'
        : 'Export saves the current generated binary snapshot through the host-managed file path.'
      : 'Export creates a new top-level run that writes the artifact through the normal file mutation path.';

  return {
    exportMode,
    showExport,
    canOpenExport,
    canSubmitExport,
    exportPlaceholder,
    exportHint,
    exportDraft,
  };
}

function createArtifactExportDraft(args: {
  exportMode: ArtifactExportMode;
  viewModel: ArtifactPaneViewModel;
  sourceAuthority: ArtifactPaneViewModel['sourceAuthority'];
  targetPath: string;
  generatedTextExportSnapshot: GeneratedTextExportSnapshot | null;
}): RunRequest | null {
  const {
    exportMode,
    viewModel,
    sourceAuthority,
    targetPath,
    generatedTextExportSnapshot,
  } = args;
  if (exportMode === 'static') {
    return buildArtifactExportRunDraftFromAuthority({
      parsed: viewModel.parsed,
      sourceAuthority,
      targetPath,
    });
  }
  if (exportMode === 'generated_text') {
    return buildGeneratedTextExportRunDraftFromAuthority({
      snapshot: generatedTextExportSnapshot,
      sourceAuthority,
      targetPath,
    });
  }
  return null;
}
