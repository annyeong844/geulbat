import { createElement } from 'react';

import { resolveJsArtifactRuntimePreview } from '../../artifacts/runtime-preview/js/preview.js';
import { resolveReactBundleArtifactRuntimePreview } from '../../artifacts/runtime-preview/react-bundle/preview.js';
import { resolveHtmlArtifactRuntimePreview } from '../../artifacts/runtime-preview/html/preview.js';
import type { ArtifactPanePreviewSurfaceModel } from '../../artifacts/artifact-pane/preview-surface-model.js';
import { resolveArtifactPanePreviewSurfaceResult as resolveArtifactPanePreviewSurfaceResultWithResolver } from '../../artifacts/runtime-preview/preview-surface-result.js';
import type { RuntimeArtifactPreviewRenderer } from '../../artifacts/artifact-renderer-capabilities.js';
import type {
  ArtifactRuntimeFrameRenderArgs,
  ArtifactPanePreviewSurfaceResult,
  ArtifactRendererDefinition,
  ArtifactRuntimePreviewContext,
} from '../../artifacts/runtime-preview/types.js';
import type { ArtifactPreviewSurface } from '../../artifacts/artifact-types.js';
import { ArtifactRuntimeFrame } from './artifact-runtime-frame.js';

const runtimeArtifactRendererRegistry: Record<
  RuntimeArtifactPreviewRenderer,
  ArtifactRendererDefinition
> = {
  html5: {
    render(payload, context) {
      return resolveHtmlArtifactRuntimePreview({
        payload,
        isStreaming: context.isStreamingPreview,
        digest: context.digest,
        sourceRef: context.sourceRef,
        renderRuntimeFrame: renderArtifactRuntimeFrame,
      });
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
        renderRuntimeFrame: renderArtifactRuntimeFrame,
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
        renderRuntimeFrame: renderArtifactRuntimeFrame,
      });
    },
  },
};

function renderArtifactRuntimeFrame(args: ArtifactRuntimeFrameRenderArgs) {
  return createElement(ArtifactRuntimeFrame, args);
}

export function resolveRuntimeArtifactPreview(
  renderer: RuntimeArtifactPreviewRenderer,
  payload: string,
  context: ArtifactRuntimePreviewContext,
): ArtifactPreviewSurface {
  return runtimeArtifactRendererRegistry[renderer].render(payload, context);
}

export function resolveArtifactPanePreviewSurfaceResult(
  model: ArtifactPanePreviewSurfaceModel,
): ArtifactPanePreviewSurfaceResult {
  return resolveArtifactPanePreviewSurfaceResultWithResolver(
    model,
    resolveRuntimeArtifactPreview,
  );
}
