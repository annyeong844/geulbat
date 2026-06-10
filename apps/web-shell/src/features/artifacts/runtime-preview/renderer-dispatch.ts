import { resolveHtmlArtifactRuntimePreview } from './html/preview.js';
import { resolveJsArtifactRuntimePreview } from './js/preview.js';
import { resolveReactBundleArtifactRuntimePreview } from './react-bundle/preview.js';
import type { RuntimeArtifactPreviewRenderer } from '../artifact-renderer-capabilities.js';
import type { ArtifactPreviewSurface } from '../artifact-types.js';
import type {
  ArtifactRendererDefinition,
  ArtifactRuntimePreviewContext,
  RenderArtifactRuntimeFrame,
} from './types.js';

const runtimeArtifactRendererRegistry: Record<
  RuntimeArtifactPreviewRenderer,
  ArtifactRendererDefinition
> = {
  html5: {
    render(payload, context, renderRuntimeFrame) {
      return resolveHtmlArtifactRuntimePreview({
        payload,
        isStreaming: context.isStreamingPreview,
        digest: context.digest,
        sourceRef: context.sourceRef,
        renderRuntimeFrame,
      });
    },
  },
  js: {
    render(payload, context, renderRuntimeFrame) {
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
        renderRuntimeFrame,
      });
    },
  },
  react_bundle: {
    render(payload, context, renderRuntimeFrame) {
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
        renderRuntimeFrame,
      });
    },
  },
};

export function resolveArtifactRuntimePreview(args: {
  renderer: RuntimeArtifactPreviewRenderer;
  payload: string;
  context: ArtifactRuntimePreviewContext;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}): ArtifactPreviewSurface {
  return runtimeArtifactRendererRegistry[args.renderer].render(
    args.payload,
    args.context,
    args.renderRuntimeFrame,
  );
}
