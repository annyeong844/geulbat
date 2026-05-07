import type { ReactBundleRuntimeManifest } from '@geulbat/protocol/react-bundle-inline-compile';
import {
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type ResolvedArtifactSourceRef,
} from '../../../artifacts/artifact-types.js';
import { buildReactBundleArtifactRuntimePayload } from './document.js';
import { validateReactBundleArtifactPayload } from '../../../artifacts/react-bundle/validator.js';
import { ArtifactRuntimeFrame } from '../../runtime-frame/artifact-runtime-frame.js';
import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../../artifacts/artifact-types.js';

export function resolveReactBundleArtifactRuntimePreview(args: {
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
  const validation = validateReactBundleArtifactPayload(payload);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return renderReactBundleArtifactRuntimePreview({
    manifest: validation.manifest,
    sourceRef,
    ...(onGeneratedTextExportSnapshotChange !== undefined
      ? { onGeneratedTextExportSnapshotChange }
      : {}),
    ...(onGeneratedBinaryExportSnapshotChange !== undefined
      ? { onGeneratedBinaryExportSnapshotChange }
      : {}),
  });
}

export function renderReactBundleArtifactRuntimePreview(args: {
  manifest: ReactBundleRuntimeManifest;
  sourceRef: ResolvedArtifactSourceRef;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): ArtifactPreviewSurface {
  const {
    manifest,
    sourceRef,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;

  return {
    kind: 'rendered',
    node: (
      <ArtifactRuntimeFrame
        renderer="react_bundle"
        title="react bundle artifact preview"
        sandbox="allow-scripts allow-forms allow-same-origin"
        runtimePayload={buildReactBundleArtifactRuntimePayload(manifest)}
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
