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
} from './inline-compile-preview-model.js';

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
}): ArtifactPreviewSurface | null {
  const {
    enabled,
    payload,
    artifactSessionKey,
    sourceRef,
    renderRuntimeFrame,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
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

  useEffect(() => {
    const initialInlineCompileState =
      buildInitialReactBundleInlineCompileState(seed);
    setInlineCompileState(initialInlineCompileState);

    if (seed.kind !== 'inline_source') {
      return;
    }

    let cancelled = false;
    void compileReactBundleInlineSource(
      seed.input,
      sourceRef.projectId ?? undefined,
    )
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
  }, [artifactSessionKey, seed, sourceRef.projectId]);

  return useMemo(
    () =>
      buildReactBundleInlineCompilePreviewSurface({
        seed,
        inlineCompileState,
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
      seed,
      sourceRef,
    ],
  );
}
