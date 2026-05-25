import {
  renderedArtifactPreview,
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
  type ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import { validateJsArtifactPayload } from '../../js/validator.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';

export function resolveJsArtifactRuntimePreview(args: {
  payload: string;
  digest: string | null;
  sourceRef: ResolvedArtifactSourceRef;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}): ArtifactPreviewSurface {
  const {
    payload,
    digest: _digest,
    sourceRef,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    renderRuntimeFrame,
  } = args;
  const validation = validateJsArtifactPayload(payload);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return renderedArtifactPreview(
    renderRuntimeFrame({
      renderer: 'js',
      title: 'js artifact preview',
      sandbox: 'allow-scripts allow-forms allow-same-origin allow-downloads',
      runtimePayload: payload,
      sourceRef,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    }),
  );
}
