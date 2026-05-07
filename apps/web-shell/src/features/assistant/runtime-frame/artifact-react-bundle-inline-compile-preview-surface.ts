import { useEffect, useMemo, useState } from 'react';
import { compileReactBundleInlineSource } from '../../../lib/api/react-bundle-inline-compile.js';
import type { ArtifactPaneViewModel } from '../../artifacts/artifact-pane-view-model.js';
import { renderReactBundleArtifactRuntimePreview } from '../artifacts/react-bundle/runtime.js';
import { readReactBundleArtifactInputPayload } from '../../artifacts/react-bundle/validator.js';
import {
  pendingArtifactPreview,
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type ArtifactRuntimeIssue,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';

type ReactBundlePreviewSeed =
  | {
      kind: 'disabled';
    }
  | ({
      kind: 'invalid';
    } & ArtifactRuntimeIssue<
      'boot_failed' | 'policy_blocked' | 'sanitize_rejected'
    >)
  | {
      kind: 'manifest';
      manifest: Parameters<
        typeof renderReactBundleArtifactRuntimePreview
      >[0]['manifest'];
    }
  | {
      kind: 'inline_source';
      input: Parameters<typeof compileReactBundleInlineSource>[0];
    };

type ReactBundleInlineCompileState =
  | {
      kind: 'idle';
    }
  | {
      kind: 'pending';
    }
  | {
      kind: 'compiled';
      manifest: Parameters<
        typeof renderReactBundleArtifactRuntimePreview
      >[0]['manifest'];
    }
  | ({
      kind: 'failed';
    } & ArtifactRuntimeIssue);

export function useReactBundleInlineCompilePreviewSurface(args: {
  enabled: boolean;
  payload: string;
  artifactSessionKey: string;
  sourceRef: ArtifactPaneViewModel['sourceRef'];
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
      buildInitialInlineCompileState(seed),
    );

  useEffect(() => {
    const initialInlineCompileState = buildInitialInlineCompileState(seed);
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

  return useMemo(
    () =>
      buildReactBundleInlineCompilePreviewSurface({
        seed,
        inlineCompileState,
        sourceRef,
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
      seed,
      sourceRef,
    ],
  );
}

function resolveReactBundlePreviewSeed(args: {
  enabled: boolean;
  payload: string;
}): ReactBundlePreviewSeed {
  const { enabled, payload } = args;
  if (!enabled) {
    return { kind: 'disabled' };
  }

  const decoded = readReactBundleArtifactInputPayload(payload);
  if (!decoded.ok) {
    return {
      kind: 'invalid',
      code: decoded.code,
      detail: decoded.detail,
    };
  }

  if (decoded.kind === 'inline_source') {
    return {
      kind: 'inline_source',
      input: decoded.input,
    };
  }

  return {
    kind: 'manifest',
    manifest: decoded.manifest,
  };
}

function buildInitialInlineCompileState(
  seed: ReactBundlePreviewSeed,
): ReactBundleInlineCompileState {
  return seed.kind === 'inline_source' ? { kind: 'pending' } : { kind: 'idle' };
}

function buildReactBundleInlineCompilePreviewSurface(args: {
  seed: ReactBundlePreviewSeed;
  inlineCompileState: ReactBundleInlineCompileState;
  sourceRef: ArtifactPaneViewModel['sourceRef'];
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): ArtifactPreviewSurface | null {
  const {
    seed,
    inlineCompileState,
    sourceRef,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;

  if (seed.kind === 'disabled') {
    return null;
  }

  if (seed.kind === 'invalid') {
    return unavailableArtifactPreview(seed.code, seed.detail);
  }

  if (seed.kind === 'manifest') {
    return renderReactBundleArtifactRuntimePreview({
      manifest: seed.manifest,
      sourceRef,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    });
  }

  if (inlineCompileState.kind === 'compiled') {
    return renderReactBundleArtifactRuntimePreview({
      manifest: inlineCompileState.manifest,
      sourceRef,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    });
  }

  if (inlineCompileState.kind === 'failed') {
    return unavailableArtifactPreview(
      inlineCompileState.code,
      inlineCompileState.detail,
    );
  }

  return pendingArtifactPreview('리액트 번들을 준비하고 있습니다...');
}
