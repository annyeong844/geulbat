import type {
  ReactBundleInlineSourceInput,
  ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';

import {
  pendingArtifactPreview,
  unavailableArtifactPreview,
  type ArtifactPreviewSurface,
  type ArtifactRuntimeIssue,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
  type ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import { readReactBundleArtifactInputPayload } from '../../react-bundle/validator.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';
import { renderReactBundleArtifactRuntimePreview } from './preview.js';

export type ReactBundlePreviewSeed =
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
      manifest: ReactBundleRuntimeManifest;
    }
  | {
      kind: 'inline_source';
      input: ReactBundleInlineSourceInput;
    };

export type ReactBundleInlineCompileState =
  | {
      kind: 'idle';
    }
  | {
      kind: 'pending';
    }
  | {
      kind: 'compiled';
      manifest: ReactBundleRuntimeManifest;
    }
  | ({
      kind: 'failed';
    } & ArtifactRuntimeIssue);

export function resolveReactBundlePreviewSeed(args: {
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

export function buildInitialReactBundleInlineCompileState(
  seed: ReactBundlePreviewSeed,
): ReactBundleInlineCompileState {
  return seed.kind === 'inline_source' ? { kind: 'pending' } : { kind: 'idle' };
}

export function buildReactBundleInlineCompilePreviewSurface(args: {
  seed: ReactBundlePreviewSeed;
  inlineCompileState: ReactBundleInlineCompileState;
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
    seed,
    inlineCompileState,
    sourceRef,
    renderRuntimeFrame,
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
      renderRuntimeFrame,
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
      renderRuntimeFrame,
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
