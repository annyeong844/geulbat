import type { ArtifactPaneViewModel } from '../../artifacts/artifact-pane-view-model.js';
import {
  resolveArtifactPanePreviewSurfaceModel,
  shouldUseArtifactPaneHookManagedPreview,
} from '../../artifacts/artifact-pane/preview-surface-model.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import { useReactBundleInlineCompilePreviewSurface } from '../runtime-frame/artifact-react-bundle-inline-compile-preview-surface.js';
import { resolveArtifactPanePreviewSurfaceResult } from '../runtime-frame/artifact-runtime-preview-adapter.js';

interface UseArtifactPanePreviewSurfaceResult {
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
}

export function useArtifactPanePreviewSurface(args: {
  viewModel: ArtifactPaneViewModel;
  artifactSessionKey: string;
  canShowPreview: boolean;
  supportsStreamingPreview: boolean;
  isLiveStreamingArtifact: boolean;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): UseArtifactPanePreviewSurfaceResult {
  const {
    viewModel,
    artifactSessionKey,
    canShowPreview,
    supportsStreamingPreview,
    isLiveStreamingArtifact,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const hookManagedPreviewSurface = useReactBundleInlineCompilePreviewSurface({
    enabled: shouldUseArtifactPaneHookManagedPreview(viewModel),
    payload: viewModel.parsed.payload,
    artifactSessionKey,
    sourceRef: viewModel.sourceRef,
    ...(onGeneratedTextExportSnapshotChange !== undefined
      ? { onGeneratedTextExportSnapshotChange }
      : {}),
    ...(onGeneratedBinaryExportSnapshotChange !== undefined
      ? { onGeneratedBinaryExportSnapshotChange }
      : {}),
  });

  const previewSurfaceModel = resolveArtifactPanePreviewSurfaceModel({
    viewModel,
    canShowPreview,
    supportsStreamingPreview,
    isLiveStreamingArtifact,
    hookManagedPreviewSurface,
    ...(onGeneratedTextExportSnapshotChange !== undefined
      ? { onGeneratedTextExportSnapshotChange }
      : {}),
    ...(onGeneratedBinaryExportSnapshotChange !== undefined
      ? { onGeneratedBinaryExportSnapshotChange }
      : {}),
  });
  return resolveArtifactPanePreviewSurfaceResult(previewSurfaceModel);
}
