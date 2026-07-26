import { brandThreadId } from '../lib/id-brand-helpers.js';

import { resolveArtifactDurabilitySourceAuthorityFromResolved } from '../features/artifacts/artifact-durability.js';
import type { ArtifactPaneViewModel } from '../features/artifacts/artifact-pane-view-model.js';

type ArtifactPaneViewModelOverrides = Partial<
  Omit<ArtifactPaneViewModel, 'artifact' | 'sourceRef' | 'sourceAuthority'>
> & {
  artifact?: Partial<ArtifactPaneViewModel['artifact']>;
  sourceRef?: Partial<ArtifactPaneViewModel['sourceRef']>;
  sourceAuthority?: ArtifactPaneViewModel['sourceAuthority'];
};

const DEFAULT_SOURCE_REF: ArtifactPaneViewModel['sourceRef'] = {
  kind: 'thread-file',
  workingDirectory: 'computer-root',
  threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
  runId: 'run-1',
  filePath: 'notes/demo.md',
  messageTimestamp: '2026-04-04T00:00:00.000Z',
  artifactId: null,
  artifactVersion: null,
  persistenceEpoch: null,
};

const DEFAULT_ARTIFACT: ArtifactPaneViewModel['artifact'] = {
  artifactId: 'art_1',
  version: 1,
  parentVersion: null,
  baseVersion: null,
  renderer: 'markdown',
  payload: '# hello',
  digest: 'fixture',
  contentHash: 'hash',
  createdAt: '2026-04-04T00:00:00.000Z',
  createdByRunId: 'run-1',
  previewValidation: { ok: true },
  title: null,
  persistenceEpoch: 0,
  sourceRef: {
    kind: 'thread-file',
    workingDirectory: 'computer-root',
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    runId: 'run-1',
    filePath: 'notes/demo.md',
    messageTimestamp: '2026-04-04T00:00:00.000Z',
  },
};

export function createArtifactPaneViewModel(
  overrides: ArtifactPaneViewModelOverrides = {},
): ArtifactPaneViewModel {
  const {
    artifact: artifactOverrides,
    planRendering: planRenderingOverride,
    sourceRef: sourceRefOverrides,
    sourceAuthority: sourceAuthorityOverride,
    ...restOverrides
  } = overrides;
  const sourceRef: ArtifactPaneViewModel['sourceRef'] = {
    ...DEFAULT_SOURCE_REF,
    ...sourceRefOverrides,
  };

  return {
    artifact: {
      ...DEFAULT_ARTIFACT,
      ...artifactOverrides,
    },
    sourceRef,
    sourceAuthority:
      sourceAuthorityOverride ??
      resolveArtifactDurabilitySourceAuthorityFromResolved({
        sourceRef,
      }),
    planRendering: planRenderingOverride ?? null,
    actions: {
      apply: { visible: true, enabled: true, reason: null },
      export: { visible: true, enabled: true, reason: null },
    },
    ...restOverrides,
  };
}
