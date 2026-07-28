import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';
import type { ReactNode } from 'react';

import type { DispatchedRuntimeArtifactPreviewRenderer } from '../artifact-renderer-capabilities.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../artifact-types.js';

export const ARTIFACT_RUNTIME_SANDBOX = 'allow-scripts allow-forms' as const;
export const ARTIFACT_RUNTIME_DOWNLOAD_SANDBOX =
  'allow-scripts allow-forms allow-downloads' as const;
export type ArtifactRuntimeSandbox =
  | typeof ARTIFACT_RUNTIME_SANDBOX
  | typeof ARTIFACT_RUNTIME_DOWNLOAD_SANDBOX;

export interface ArtifactRuntimePreviewContext {
  digest: string | null;
  sourceRef: ResolvedArtifactSourceRef;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}

export interface ArtifactRuntimeFrameRenderArgs {
  renderer: ArtifactRuntimePersistenceRenderer;
  title: string;
  sandbox: ArtifactRuntimeSandbox;
  runtimePayload: string;
  sourceRef: ResolvedArtifactSourceRef;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}

export type RenderArtifactRuntimeFrame = (
  args: ArtifactRuntimeFrameRenderArgs,
) => ReactNode;

export interface ArtifactRendererDefinition {
  render: (
    payload: string,
    context: ArtifactRuntimePreviewContext,
    renderRuntimeFrame: RenderArtifactRuntimeFrame,
  ) => ArtifactPreviewSurface;
}

export type RuntimeArtifactPreviewResolver = (
  renderer: DispatchedRuntimeArtifactPreviewRenderer,
  payload: string,
  context: ArtifactRuntimePreviewContext,
) => ArtifactPreviewSurface;

export interface ArtifactPanePreviewSurfaceResult {
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
}
