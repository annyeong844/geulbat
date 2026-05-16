import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';
import type { ReactNode } from 'react';

import type { RuntimeArtifactPreviewRenderer } from '../artifact-renderer-capabilities.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../artifact-types.js';

export interface ArtifactRuntimePreviewContext {
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

export interface ArtifactRuntimeFrameRenderArgs {
  renderer: ArtifactRuntimePersistenceRenderer;
  title: string;
  sandbox: string;
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
  ) => ArtifactPreviewSurface;
}

export type RuntimeArtifactPreviewResolver = (
  renderer: RuntimeArtifactPreviewRenderer,
  payload: string,
  context: ArtifactRuntimePreviewContext,
) => ArtifactPreviewSurface;

export interface ArtifactPanePreviewSurfaceResult {
  previewSurface: ArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
}
