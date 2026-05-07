import { resolveJsArtifactRuntimePreview } from '../artifacts/js/runtime.js';
import { resolveReactBundleArtifactRuntimePreview } from '../artifacts/react-bundle/runtime.js';
import { resolveHtmlArtifactRuntimePreview } from '../artifacts/html/preview.js';
import type { ArtifactPanePreviewSurfaceModel } from '../../artifacts/artifact-pane/preview-surface-model.js';
import { describeArtifactRuntimeUnavailableMessage } from '../../artifacts/artifact-runtime-unavailable-message.js';
import type { RuntimeArtifactPreviewRenderer } from '../../artifacts/artifact-renderer-capabilities.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';

interface ArtifactPreviewContext {
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

interface ArtifactRendererDefinition {
  render: (
    payload: string,
    context: ArtifactPreviewContext,
  ) => ArtifactPreviewSurface;
}

interface ArtifactPanePreviewSurfaceResult {
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
}

const runtimeArtifactRendererRegistry: Record<
  RuntimeArtifactPreviewRenderer,
  ArtifactRendererDefinition
> = {
  html5: {
    render(payload, context) {
      return resolveHtmlArtifactRuntimePreview(
        payload,
        context.isStreamingPreview,
        context.digest,
        context.sourceRef,
      );
    },
  },
  js: {
    render(payload, context) {
      return resolveJsArtifactRuntimePreview({
        payload,
        digest: context.digest,
        sourceRef: context.sourceRef,
        ...(context.onGeneratedTextExportSnapshotChange !== undefined
          ? {
              onGeneratedTextExportSnapshotChange:
                context.onGeneratedTextExportSnapshotChange,
            }
          : {}),
        ...(context.onGeneratedBinaryExportSnapshotChange !== undefined
          ? {
              onGeneratedBinaryExportSnapshotChange:
                context.onGeneratedBinaryExportSnapshotChange,
            }
          : {}),
      });
    },
  },
  react_bundle: {
    render(payload, context) {
      return resolveReactBundleArtifactRuntimePreview({
        payload,
        digest: context.digest,
        sourceRef: context.sourceRef,
        ...(context.onGeneratedTextExportSnapshotChange !== undefined
          ? {
              onGeneratedTextExportSnapshotChange:
                context.onGeneratedTextExportSnapshotChange,
            }
          : {}),
        ...(context.onGeneratedBinaryExportSnapshotChange !== undefined
          ? {
              onGeneratedBinaryExportSnapshotChange:
                context.onGeneratedBinaryExportSnapshotChange,
            }
          : {}),
      });
    },
  },
};

export function resolveRuntimeArtifactPreview(
  renderer: RuntimeArtifactPreviewRenderer,
  payload: string,
  context: ArtifactPreviewContext,
): ArtifactPreviewSurface {
  return runtimeArtifactRendererRegistry[renderer].render(payload, context);
}

export function resolveArtifactPanePreviewSurfaceResult(
  model: ArtifactPanePreviewSurfaceModel,
): ArtifactPanePreviewSurfaceResult {
  const previewSurface =
    model.kind === 'runtime'
      ? resolveRuntimeArtifactPreview(
          model.renderer,
          model.payload,
          model.context,
        )
      : model.previewSurface;
  const runtimeUnavailableMessage =
    previewSurface?.kind === 'unavailable'
      ? describeArtifactRuntimeUnavailableMessage(previewSurface)
      : null;

  return {
    previewSurface,
    runtimeUnavailableMessage,
  };
}
