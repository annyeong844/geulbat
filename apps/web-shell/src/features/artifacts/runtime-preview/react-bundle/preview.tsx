import type { ReactBundleRuntimeManifest } from '@geulbat/protocol/react-bundle-inline-compile';
import {
  renderedArtifactPreview,
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
  type ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import { buildReactBundleArtifactRuntimePayload } from './document.js';
import { validateReactBundleArtifactPayload } from '../../react-bundle/validator.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';

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
    renderRuntimeFrame,
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
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}): ArtifactPreviewSurface {
  const {
    manifest,
    sourceRef,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    renderRuntimeFrame,
  } = args;
  const serializedManifest = JSON.stringify(manifest);
  if (serializedManifest === undefined) {
    return unavailableArtifactPreview(
      'boot_failed',
      'react bundle runtime manifest must be serializable',
    );
  }

  const validation = validateReactBundleArtifactPayload(serializedManifest);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return renderedArtifactPreview(
    renderRuntimeFrame({
      renderer: 'react_bundle',
      title: 'react bundle artifact preview',
      sandbox: 'allow-scripts allow-forms allow-same-origin',
      runtimePayload: buildReactBundleArtifactRuntimePayload(
        validation.manifest,
      ),
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
