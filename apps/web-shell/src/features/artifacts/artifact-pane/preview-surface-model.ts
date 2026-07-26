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
  return usesHookManagedArtifactPreview(viewModel.artifact.renderer);
}

export function resolveArtifactPanePreviewSurfaceModel(args: {
  viewModel: ArtifactPaneViewModel;
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
    hookManagedPreviewSurface,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const { artifact } = viewModel;
  if (usesHookManagedArtifactPreview(artifact.renderer)) {
    return surfacePreviewModel(hookManagedPreviewSurface);
  }
  if (isStaticArtifactPreviewRenderer(artifact.renderer)) {
    const sourceThreadId = viewModel.sourceRef?.threadId;
    return surfacePreviewModel(
      resolveStaticArtifactPreview(artifact.renderer, artifact.payload, {
        // video 등 미디어 참조 렌더러의 스레드 스코프(§4.6) — 커밋 시
        // sourceRef가 항상 threadId를 갖는다
        ...(typeof sourceThreadId === 'string' && sourceThreadId !== ''
          ? { threadId: sourceThreadId }
          : {}),
      }),
    );
  }
  if (!isDispatchedRuntimeArtifactPreviewRenderer(artifact.renderer)) {
    return surfacePreviewModel(null);
  }

  const supportsRuntimeGeneratedExports =
    supportsRuntimeGeneratedExportSnapshots(artifact.renderer);
  return {
    kind: 'runtime',
    renderer: artifact.renderer,
    payload: artifact.payload,
    context: {
      digest: artifact.digest,
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
