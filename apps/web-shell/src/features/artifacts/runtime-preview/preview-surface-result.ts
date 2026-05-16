import type { ArtifactPanePreviewSurfaceModel } from '../artifact-pane/preview-surface-model.js';
import { describeArtifactRuntimeUnavailableMessage } from '../artifact-runtime-unavailable-message.js';
import type { ArtifactPreviewSurface } from '../artifact-types.js';
import type {
  ArtifactPanePreviewSurfaceResult,
  RuntimeArtifactPreviewResolver,
} from './types.js';

export function resolveArtifactPanePreviewSurfaceResult(
  model: ArtifactPanePreviewSurfaceModel,
  resolveRuntimeArtifactPreview: RuntimeArtifactPreviewResolver,
): ArtifactPanePreviewSurfaceResult {
  switch (model.kind) {
    case 'runtime':
      return toPanePreviewSurfaceResult(
        resolveRuntimeArtifactPreview(
          model.renderer,
          model.payload,
          model.context,
        ),
      );
    case 'surface':
      return toPanePreviewSurfaceResult(model.previewSurface);
    default:
      return assertNever(model);
  }
}

function toPanePreviewSurfaceResult(
  previewSurface: ArtifactPreviewSurface | null,
): ArtifactPanePreviewSurfaceResult {
  return {
    previewSurface,
    runtimeUnavailableMessage:
      previewSurface?.kind === 'unavailable'
        ? describeArtifactRuntimeUnavailableMessage(previewSurface)
        : null,
  };
}

function assertNever(value: never): never {
  throw new Error(
    `Unhandled artifact pane preview surface model: ${String(value)}`,
  );
}
