import { brandThreadId } from '../lib/id-brand-helpers.js';

import { resolveArtifactDurabilitySourceAuthorityFromResolved } from '../features/artifacts/artifact-durability.js';
import type { ArtifactPaneViewModel } from '../features/artifacts/artifact-pane-view-model.js';

type ArtifactPaneViewModelOverrides = Partial<
  Omit<ArtifactPaneViewModel, 'sourceRef' | 'sourceAuthority'>
> & {
  sourceRef?: Partial<ArtifactPaneViewModel['sourceRef']>;
  sourceAuthority?: ArtifactPaneViewModel['sourceAuthority'];
};

const DEFAULT_SOURCE_REF: ArtifactPaneViewModel['sourceRef'] = {
  kind: 'thread-file',
  workingDirectory: 'workspace',
  threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
  runId: 'run-1',
  filePath: 'notes/demo.md',
  messageTimestamp: '2026-04-04T00:00:00.000Z',
  artifactId: null,
  artifactVersion: null,
  persistenceEpoch: null,
};

export function createArtifactPaneViewModel(
  overrides: ArtifactPaneViewModelOverrides = {},
): ArtifactPaneViewModel {
  const {
    sourceRef: sourceRefOverrides,
    sourceAuthority: sourceAuthorityOverride,
    ...restOverrides
  } = overrides;
  const sourceRef: ArtifactPaneViewModel['sourceRef'] = {
    ...DEFAULT_SOURCE_REF,
    ...sourceRefOverrides,
  };

  return {
    parsed: {
      kind: 'artifact',
      state: 'completed',
      renderer: 'markdown',
      digest: 'fixture',
      payload: '# hello',
      raw: '# hello',
    },
    sourceRef,
    sourceAuthority:
      sourceAuthorityOverride ??
      resolveArtifactDurabilitySourceAuthorityFromResolved({
        sourceRef,
      }),
    actions: {
      apply: { visible: true, enabled: true, reason: null },
      export: { visible: true, enabled: true, reason: null },
    },
    ...restOverrides,
  };
}
