import {
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type ResolvedArtifactSourceRef,
} from '../../../artifacts/artifact-types.js';
import { validateJsArtifactPayload } from '../../../artifacts/js/validator.js';
import { ArtifactRuntimeFrame } from '../../runtime-frame/artifact-runtime-frame.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../../artifacts/artifact-types.js';

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
}): ArtifactPreviewSurface {
  const {
    payload,
    digest: _digest,
    sourceRef,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const validation = validateJsArtifactPayload(payload);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return {
    kind: 'rendered',
    node: (
      <ArtifactRuntimeFrame
        renderer="js"
        title="js artifact preview"
        sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
        runtimePayload={payload}
        sourceRef={sourceRef}
        {...(onGeneratedTextExportSnapshotChange !== undefined
          ? { onGeneratedTextExportSnapshotChange }
          : {})}
        {...(onGeneratedBinaryExportSnapshotChange !== undefined
          ? { onGeneratedBinaryExportSnapshotChange }
          : {})}
      />
    ),
  };
}
