import {
  isArtifactRenderer,
  type ArtifactRenderer,
} from '@geulbat/protocol/artifacts';

export type RuntimeArtifactPreviewRenderer = Extract<
  ArtifactRenderer,
  'html5' | 'js' | 'react_bundle'
>;

export type HookManagedArtifactPreviewRenderer = Extract<
  RuntimeArtifactPreviewRenderer,
  'react_bundle'
>;

export type DispatchedRuntimeArtifactPreviewRenderer = Exclude<
  RuntimeArtifactPreviewRenderer,
  HookManagedArtifactPreviewRenderer
>;

const GENERATED_TEXT_EXPORT_RENDERERS: Partial<Record<ArtifactRenderer, true>> =
  {
    js: true,
    react_bundle: true,
  };

const GENERATED_BINARY_EXPORT_RENDERERS: Partial<
  Record<ArtifactRenderer, true>
> = {
  js: true,
  react_bundle: true,
};

const STREAMING_PREVIEW_RENDERERS: Partial<Record<ArtifactRenderer, true>> = {
  html5: true,
};

const HOOK_MANAGED_PREVIEW_RENDERERS: Partial<Record<ArtifactRenderer, true>> =
  {
    react_bundle: true,
  };

const RUNTIME_PREVIEW_RENDERERS: Partial<Record<ArtifactRenderer, true>> = {
  html5: true,
  js: true,
  react_bundle: true,
};

export function supportsGeneratedTextExportSnapshot(
  renderer: string | null,
): boolean {
  return (
    isArtifactRenderer(renderer) &&
    GENERATED_TEXT_EXPORT_RENDERERS[renderer] === true
  );
}

export function supportsGeneratedBinaryExportSnapshot(
  renderer: string | null,
): boolean {
  return (
    isArtifactRenderer(renderer) &&
    GENERATED_BINARY_EXPORT_RENDERERS[renderer] === true
  );
}

export function supportsRuntimeGeneratedExportSnapshots(
  renderer: string | null,
): boolean {
  return (
    supportsGeneratedTextExportSnapshot(renderer) ||
    supportsGeneratedBinaryExportSnapshot(renderer)
  );
}

export function supportsStreamingArtifactPreview(
  renderer: string | null,
): boolean {
  return (
    isArtifactRenderer(renderer) &&
    STREAMING_PREVIEW_RENDERERS[renderer] === true
  );
}

export function usesHookManagedArtifactPreview(
  renderer: string | null,
): renderer is HookManagedArtifactPreviewRenderer {
  return (
    isArtifactRenderer(renderer) &&
    HOOK_MANAGED_PREVIEW_RENDERERS[renderer] === true
  );
}

export function isRuntimeArtifactPreviewRenderer(
  renderer: string | null,
): renderer is RuntimeArtifactPreviewRenderer {
  return (
    isArtifactRenderer(renderer) && RUNTIME_PREVIEW_RENDERERS[renderer] === true
  );
}

export function isDispatchedRuntimeArtifactPreviewRenderer(
  renderer: string | null,
): renderer is DispatchedRuntimeArtifactPreviewRenderer {
  return (
    isRuntimeArtifactPreviewRenderer(renderer) &&
    !usesHookManagedArtifactPreview(renderer)
  );
}
