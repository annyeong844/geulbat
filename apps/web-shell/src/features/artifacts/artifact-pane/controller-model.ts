import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type { ArtifactPreviewSurface } from '../artifact-types.js';
import type { ArtifactPaneBodyProps } from './body.js';
import type { ArtifactPaneExportPanelProps } from './export-panel.js';
import type { ArtifactPaneHeaderProps } from './header.js';
import type { ArtifactSurfaceStateBadge, ArtifactTab } from './types.js';

// "파일로 저장" 대상 — OS 저장 대화상자로 payload를 로컬 파일에 내려받는다
interface ArtifactDirectSaveTarget {
  payload: string;
  defaultPath: string;
}

export interface ArtifactPaneControllerProps {
  headerProps: ArtifactPaneHeaderProps;
  exportPanelProps: ArtifactPaneExportPanelProps | null;
  bodyProps: ArtifactPaneBodyProps;
  directSave: ArtifactDirectSaveTarget | null;
}

export interface ArtifactPaneControllerPaneState {
  tab: ArtifactTab;
  canShowPreview: boolean;
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

const DIRECT_SAVE_EXTENSIONS: Record<string, string> = {
  markdown: 'md',
  code: 'txt',
  table: 'md',
  diff: 'md',
  html5: 'html',
  js: 'html',
  react_bundle: 'html',
};

// 에디터 아티팩트 표면도 같은 저장 대상 파생을 공유한다 (포크 금지)
export function buildDirectSaveTarget(
  viewModel: ArtifactPaneViewModel,
): ArtifactDirectSaveTarget | null {
  const { parsed, sourceRef } = viewModel;
  if (
    parsed.kind !== 'artifact' ||
    parsed.state !== 'completed' ||
    parsed.renderer === null
  ) {
    return null;
  }
  const ext = DIRECT_SAVE_EXTENSIONS[parsed.renderer];
  if (!ext || parsed.payload.trim().length === 0) {
    return null;
  }
  const baseName = sourceRef.artifactId ?? 'artifact';
  return {
    payload: parsed.payload,
    defaultPath: `${baseName}.${ext}`,
  };
}

export function buildArtifactPaneControllerProps(args: {
  label: string;
  viewModel: ArtifactPaneViewModel;
  paneState: ArtifactPaneControllerPaneState;
  exportState: ArtifactPaneControllerExportState;
}): ArtifactPaneControllerProps {
  const { label, viewModel, paneState, exportState } = args;

  return {
    directSave: buildDirectSaveTarget(viewModel),
    headerProps: {
      label,
      surfaceStateBadge: paneState.surfaceStateBadge,
      tab: paneState.tab,
      canShowPreview: paneState.canShowPreview,
      showApply: paneState.showApply,
      canApply: paneState.canApply,
      showExport: exportState.showExport,
      exportExpanded: exportState.exportExpanded,
      canOpenExport: exportState.canOpenExport,
      onSelectTab: paneState.handleSelectTab,
      onApply: paneState.handleApply,
      onToggleExport: exportState.handleToggleExport,
    },
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
