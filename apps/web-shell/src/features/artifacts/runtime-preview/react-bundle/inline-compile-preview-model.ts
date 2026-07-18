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

export type ReactBundlePreviewModule = typeof import('./preview.js');

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

export type ReactBundleRuntimePreviewLoadState =
  | {
      kind: 'idle' | 'loading';
    }
  | {
      kind: 'ready';
      previewModule: ReactBundlePreviewModule;
    }
  | {
      kind: 'failed';
      detail: string;
    };

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
  runtimePreviewLoadState: ReactBundleRuntimePreviewLoadState;
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
    runtimePreviewLoadState,
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

  let manifest: ReactBundleRuntimeManifest;
  if (seed.kind === 'manifest') {
    manifest = seed.manifest;
  } else if (inlineCompileState.kind === 'compiled') {
    manifest = inlineCompileState.manifest;
  } else if (inlineCompileState.kind === 'failed') {
    return unavailableArtifactPreview(
      inlineCompileState.code,
      inlineCompileState.detail,
    );
  } else {
    return pendingArtifactPreview('리액트 번들을 준비하고 있습니다...');
  }

  if (runtimePreviewLoadState.kind === 'failed') {
    return unavailableArtifactPreview(
      'boot_failed',
      runtimePreviewLoadState.detail,
    );
  }
  if (runtimePreviewLoadState.kind !== 'ready') {
    return pendingArtifactPreview('리액트 번들을 준비하고 있습니다...');
  }

  return runtimePreviewLoadState.previewModule.renderReactBundleArtifactRuntimePreview(
    {
      manifest,
      sourceRef,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
      renderRuntimeFrame,
    },
  );
}
