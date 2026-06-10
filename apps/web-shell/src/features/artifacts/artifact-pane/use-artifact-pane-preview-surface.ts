import {
  resolveArtifactPanePreviewSurfaceModel,
  shouldUseArtifactPaneHookManagedPreview,
} from './preview-surface-model.js';
import { resolveArtifactPanePreviewSurfaceResult } from '../runtime-preview/preview-surface-result.js';
import { resolveArtifactRuntimePreview } from '../runtime-preview/renderer-dispatch.js';
import { useReactBundleInlineCompilePreviewSurface } from '../runtime-preview/react-bundle/use-inline-compile-preview-surface.js';
import type {
  ArtifactPanePreviewSurfaceResult,
  RenderArtifactRuntimeFrame,
} from '../runtime-preview/types.js';
import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../artifact-types.js';

export function useArtifactPanePreviewSurface(args: {
  viewModel: ArtifactPaneViewModel;
  artifactSessionKey: string;
  canShowPreview: boolean;
  supportsStreamingPreview: boolean;
  isLiveStreamingArtifact: boolean;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): ArtifactPanePreviewSurfaceResult {
  const {
    viewModel,
    artifactSessionKey,
    canShowPreview,
    supportsStreamingPreview,
    isLiveStreamingArtifact,
    renderRuntimeFrame,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const hookManagedPreviewSurface = useReactBundleInlineCompilePreviewSurface({
    enabled: shouldUseArtifactPaneHookManagedPreview(viewModel),
    payload: viewModel.parsed.payload,
    artifactSessionKey,
    sourceRef: viewModel.sourceRef,
    renderRuntimeFrame,
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
  return resolveArtifactPanePreviewSurfaceResult(
    previewSurfaceModel,
    (renderer, payload, context) =>
      resolveArtifactRuntimePreview({
        renderer,
        payload,
        context,
        renderRuntimeFrame,
      }),
  );
}
