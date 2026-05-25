import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type { ArtifactPreviewSurface } from '../artifact-types.js';
import type { ArtifactPaneBodyProps } from './body.js';
import type { ArtifactPaneExportPanelProps } from './export-panel.js';
import type { ArtifactPaneHeaderProps } from './header.js';
import type { ArtifactSurfaceStateBadge, ArtifactTab } from './types.js';

export interface ArtifactPaneControllerProps {
  headerProps: ArtifactPaneHeaderProps;
  exportPanelProps: ArtifactPaneExportPanelProps | null;
  bodyProps: ArtifactPaneBodyProps;
}

export interface ArtifactPaneControllerPaneState {
  tab: ArtifactTab;
  canShowPreview: boolean;
  showOpenSource: boolean;
  showApply: boolean;
  canApply: boolean;
  surfaceStateBadge: ArtifactSurfaceStateBadge | null;
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
  handleSelectTab: (tab: ArtifactTab) => Promise<void> | void;
  handleApply: () => Promise<void> | void;
}

export interface ArtifactPaneControllerExportState {
  exportExpanded: boolean;
  exportTargetPath: string;
  showExport: boolean;
  canOpenExport: boolean;
  canSubmitExport: boolean;
  exportPlaceholder: string;
  exportHint: string;
  generatedBinaryOverwriteArmed: boolean;
  canOfferRememberedBinaryOverwrite: boolean;
  generatedBinaryExportPending: boolean;
  generatedBinaryExportError: string | null;
  handleToggleExport: () => Promise<void> | void;
  handleExportChange: (nextValue: string) => void;
  handleExportCancel: () => void;
  handleExportSubmit: () => Promise<void>;
  handleToggleOverwrite: (checked: boolean) => void;
}

export function buildArtifactPaneControllerProps(args: {
  label: string;
  viewModel: ArtifactPaneViewModel;
  paneState: ArtifactPaneControllerPaneState;
  exportState: ArtifactPaneControllerExportState;
  onOpenSource?: (path: string) => Promise<void> | void;
}): ArtifactPaneControllerProps {
  const { label, viewModel, paneState, exportState, onOpenSource } = args;
  const sourceFilePath = paneState.showOpenSource
    ? viewModel.sourceRef.filePath
    : null;
  const handleOpenSource =
    sourceFilePath !== null && onOpenSource !== undefined
      ? () => onOpenSource(sourceFilePath)
      : undefined;

  const headerBaseProps: Omit<ArtifactPaneHeaderProps, 'onOpenSource'> = {
    label,
    surfaceStateBadge: paneState.surfaceStateBadge,
    tab: paneState.tab,
    canShowPreview: paneState.canShowPreview,
    showApply: paneState.showApply,
    canApply: paneState.canApply,
    showExport: exportState.showExport,
    exportExpanded: exportState.exportExpanded,
    canOpenExport: exportState.canOpenExport,
    showOpenSource: paneState.showOpenSource && handleOpenSource !== undefined,
    onSelectTab: paneState.handleSelectTab,
    onApply: paneState.handleApply,
    onToggleExport: exportState.handleToggleExport,
  };

  return {
    headerProps:
      handleOpenSource !== undefined
        ? { ...headerBaseProps, onOpenSource: handleOpenSource }
        : headerBaseProps,
    exportPanelProps:
      exportState.exportExpanded && exportState.showExport
        ? {
            placeholder: exportState.exportPlaceholder,
            value: exportState.exportTargetPath,
            canOpenExport: exportState.canOpenExport,
            canSubmitExport: exportState.canSubmitExport,
            isPending: exportState.generatedBinaryExportPending,
            canOfferRememberedBinaryOverwrite:
              exportState.canOfferRememberedBinaryOverwrite,
            generatedBinaryOverwriteArmed:
              exportState.generatedBinaryOverwriteArmed,
            exportHint: exportState.exportHint,
            error: exportState.generatedBinaryExportError,
            onChangeValue: exportState.handleExportChange,
            onToggleOverwrite: exportState.handleToggleOverwrite,
            onSubmit: exportState.handleExportSubmit,
            onCancel: exportState.handleExportCancel,
          }
        : null,
    bodyProps: {
      parsed: viewModel.parsed,
      tab: paneState.tab,
      canShowPreview: paneState.canShowPreview,
      previewSurface: paneState.previewSurface,
      runtimeUnavailableMessage: paneState.runtimeUnavailableMessage,
    },
  };
}
