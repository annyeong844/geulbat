import {
  isRuntimeArtifactPreviewRenderer,
  supportsRuntimeGeneratedExportSnapshots,
  usesHookManagedArtifactPreview,
  type RuntimeArtifactPreviewRenderer,
} from '../artifact-renderer-capabilities.js';
import {
  isStaticArtifactPreviewRenderer,
  resolveStaticArtifactPreview,
} from '../artifact-static-preview-registry.js';
import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../artifact-types.js';

interface ArtifactPaneRuntimePreviewContext {
  digest: string | null;
  state: 'streaming' | 'completed' | 'fallback';
  isStreamingPreview: boolean;
  sourceRef: ResolvedArtifactSourceRef;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}

export type ArtifactPanePreviewSurfaceModel =
  | {
      kind: 'surface';
      previewSurface: ArtifactPreviewSurface | null;
    }
  | {
      kind: 'runtime';
      renderer: RuntimeArtifactPreviewRenderer;
      payload: string;
      context: ArtifactPaneRuntimePreviewContext;
    };

export function shouldUseArtifactPaneHookManagedPreview(
  viewModel: ArtifactPaneViewModel,
): boolean {
  const parsed = viewModel.parsed;
  return (
    usesHookManagedArtifactPreview(parsed.renderer) &&
    parsed.state === 'completed'
  );
}

export function resolveArtifactPanePreviewSurfaceModel(args: {
  viewModel: ArtifactPaneViewModel;
  canShowPreview: boolean;
  supportsStreamingPreview: boolean;
  isLiveStreamingArtifact: boolean;
  hookManagedPreviewSurface: ArtifactPreviewSurface | null;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): ArtifactPanePreviewSurfaceModel {
  const {
    viewModel,
    canShowPreview,
    supportsStreamingPreview,
    isLiveStreamingArtifact,
    hookManagedPreviewSurface,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  if (!canShowPreview) {
    return surfacePreviewModel(null);
  }

  const { parsed } = viewModel;
  if (usesHookManagedArtifactPreview(parsed.renderer)) {
    return surfacePreviewModel(hookManagedPreviewSurface);
  }
  if (isStaticArtifactPreviewRenderer(parsed.renderer)) {
    return surfacePreviewModel(
      resolveStaticArtifactPreview(parsed.renderer, parsed.payload),
    );
  }
  if (!isRuntimeArtifactPreviewRenderer(parsed.renderer)) {
    return surfacePreviewModel(null);
  }

  const supportsRuntimeGeneratedExports =
    supportsRuntimeGeneratedExportSnapshots(parsed.renderer);
  return {
    kind: 'runtime',
    renderer: parsed.renderer,
    payload: parsed.payload,
    context: {
      digest: parsed.digest,
      state: parsed.state,
      isStreamingPreview:
        supportsStreamingPreview &&
        (parsed.state === 'streaming' || isLiveStreamingArtifact),
      sourceRef: viewModel.sourceRef,
      ...(supportsRuntimeGeneratedExports &&
      onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(supportsRuntimeGeneratedExports &&
      onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    },
  };
}

function surfacePreviewModel(
  previewSurface: ArtifactPreviewSurface | null,
): ArtifactPanePreviewSurfaceModel {
  return {
    kind: 'surface',
    previewSurface,
  };
}
