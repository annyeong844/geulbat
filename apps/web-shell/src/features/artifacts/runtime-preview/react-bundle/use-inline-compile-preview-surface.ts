import { getErrorMessage } from '@geulbat/shared-utils/error';
import { useEffect, useMemo, useState } from 'react';

import { compileReactBundleInlineSource } from '../../../../lib/api/react-bundle-inline-compile.js';
import type {
  ArtifactPreviewSurface,
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';
import {
  buildInitialReactBundleInlineCompileState,
  buildReactBundleInlineCompilePreviewSurface,
  resolveReactBundlePreviewSeed,
  type ReactBundleInlineCompileState,
  type ReactBundlePreviewModule,
  type ReactBundleRuntimePreviewLoadState,
} from './inline-compile-preview-model.js';

type LoadReactBundlePreviewModule = () => Promise<ReactBundlePreviewModule>;

type ReadyReactBundleRuntimePreviewLoadState = Extract<
  ReactBundleRuntimePreviewLoadState,
  { kind: 'ready' }
>;

type ReactBundlePreviewModuleCacheEntry =
  | {
      kind: 'loading';
      promise: Promise<ReadyReactBundleRuntimePreviewLoadState>;
    }
  | ReadyReactBundleRuntimePreviewLoadState;

const reactBundlePreviewModuleCache = new WeakMap<
  LoadReactBundlePreviewModule,
  ReactBundlePreviewModuleCacheEntry
>();

function loadReactBundlePreviewModule(): Promise<ReactBundlePreviewModule> {
  return import('./preview.js');
}

function loadCachedReactBundlePreviewModule(
  loadPreviewModule: LoadReactBundlePreviewModule,
): Promise<ReadyReactBundleRuntimePreviewLoadState> {
  const cached = reactBundlePreviewModuleCache.get(loadPreviewModule);
  if (cached?.kind === 'ready') {
    return Promise.resolve(cached);
  }
  if (cached?.kind === 'loading') {
    return cached.promise;
  }

  const loadPromise = Promise.resolve()
    .then(loadPreviewModule)
    .then(
      (previewModule) => {
        const readyState: ReadyReactBundleRuntimePreviewLoadState = {
          kind: 'ready',
          previewModule,
        };
        reactBundlePreviewModuleCache.set(loadPreviewModule, readyState);
        return readyState;
      },
      (error: unknown) => {
        reactBundlePreviewModuleCache.delete(loadPreviewModule);
        throw error;
      },
    );
  reactBundlePreviewModuleCache.set(loadPreviewModule, {
    kind: 'loading',
    promise: loadPromise,
  });
  return loadPromise;
}

export function useReactBundleInlineCompilePreviewSurface(args: {
  enabled: boolean;
  payload: string;
  artifactSessionKey: string;
  sourceRef: ResolvedArtifactSourceRef;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
  loadPreviewModule?: LoadReactBundlePreviewModule;
}): ArtifactPreviewSurface | null {
  const {
    enabled,
    payload,
    artifactSessionKey,
    sourceRef,
    renderRuntimeFrame,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    loadPreviewModule = loadReactBundlePreviewModule,
  } = args;
  const seed = useMemo(
    () =>
      resolveReactBundlePreviewSeed({
        enabled,
        payload,
      }),
    [enabled, payload],
  );
  const [inlineCompileState, setInlineCompileState] =
    useState<ReactBundleInlineCompileState>(() =>
      buildInitialReactBundleInlineCompileState(seed),
    );
  const shouldLoadRuntimePreview =
    seed.kind === 'manifest' || seed.kind === 'inline_source';
  const [runtimePreviewLoadState, setRuntimePreviewLoadState] =
    useState<ReactBundleRuntimePreviewLoadState>(() => {
      const cached = reactBundlePreviewModuleCache.get(loadPreviewModule);
      if (shouldLoadRuntimePreview && cached?.kind === 'ready') {
        return cached;
      }
      return { kind: 'idle' };
    });

  useEffect(() => {
    const initialInlineCompileState =
      buildInitialReactBundleInlineCompileState(seed);
    setInlineCompileState(initialInlineCompileState);

    if (seed.kind !== 'inline_source') {
      return;
    }

    let cancelled = false;
    void compileReactBundleInlineSource(seed.input)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setInlineCompileState({
            kind: 'failed',
            code: response.code,
            detail: response.detail,
          });
          return;
        }
        setInlineCompileState({
          kind: 'compiled',
          manifest: response.manifest,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setInlineCompileState({
          kind: 'failed',
          code: 'boot_failed',
          detail:
            error instanceof Error
              ? error.message
              : 'react bundle inline compile failed',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [artifactSessionKey, seed]);

  useEffect(() => {
    if (!shouldLoadRuntimePreview) {
      setRuntimePreviewLoadState({ kind: 'idle' });
      return;
    }
    const cached = reactBundlePreviewModuleCache.get(loadPreviewModule);
    if (cached?.kind === 'ready') {
      setRuntimePreviewLoadState((current) =>
        current === cached ? current : cached,
      );
      return;
    }

    let cancelled = false;
    setRuntimePreviewLoadState({ kind: 'loading' });
    void loadCachedReactBundlePreviewModule(loadPreviewModule)
      .then((readyState) => {
        if (!cancelled) {
          setRuntimePreviewLoadState(readyState);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntimePreviewLoadState({
            kind: 'failed',
            detail: getErrorMessage(
              error,
              'react bundle runtime preview failed to load',
            ),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifactSessionKey, loadPreviewModule, shouldLoadRuntimePreview]);

  return useMemo(
    () =>
      buildReactBundleInlineCompilePreviewSurface({
        seed,
        inlineCompileState,
        runtimePreviewLoadState,
        sourceRef,
        renderRuntimeFrame,
        ...(onGeneratedTextExportSnapshotChange !== undefined
          ? { onGeneratedTextExportSnapshotChange }
          : {}),
        ...(onGeneratedBinaryExportSnapshotChange !== undefined
          ? { onGeneratedBinaryExportSnapshotChange }
          : {}),
      }),
    [
      inlineCompileState,
      onGeneratedBinaryExportSnapshotChange,
      onGeneratedTextExportSnapshotChange,
      renderRuntimeFrame,
      runtimePreviewLoadState,
      seed,
      sourceRef,
    ],
  );
}
