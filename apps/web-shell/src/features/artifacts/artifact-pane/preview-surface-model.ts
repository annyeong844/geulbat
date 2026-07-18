import {
  isDispatchedRuntimeArtifactPreviewRenderer,
  supportsRuntimeGeneratedExportSnapshots,
  usesHookManagedArtifactPreview,
  type DispatchedRuntimeArtifactPreviewRenderer,
} from '../artifact-renderer-capabilities.js';
import {
  isStaticArtifactPreviewRenderer,
  resolveStaticArtifactPreview,
} from '../artifact-static-preview-registry.js';
import type { ArtifactPaneViewModel } from '../artifact-pane-view-model.js';
import type { ArtifactRuntimePreviewContext } from '../runtime-preview/types.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../artifact-types.js';

export type ArtifactPanePreviewSurfaceModel =
  | {
      kind: 'surface';
      previewSurface: ArtifactPreviewSurface | null;
    }
  | {
      kind: 'runtime';
      renderer: DispatchedRuntimeArtifactPreviewRenderer;
      payload: string;
      context: ArtifactRuntimePreviewContext;
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
    const sourceThreadId = viewModel.sourceRef?.threadId;
    return surfacePreviewModel(
      resolveStaticArtifactPreview(parsed.renderer, parsed.payload, {
        // video 등 미디어 참조 렌더러의 스레드 스코프(§4.6) — 커밋 시
        // sourceRef가 항상 threadId를 갖는다
        ...(typeof sourceThreadId === 'string' && sourceThreadId !== ''
          ? { threadId: sourceThreadId }
          : {}),
      }),
    );
  }
  if (!isDispatchedRuntimeArtifactPreviewRenderer(parsed.renderer)) {
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
