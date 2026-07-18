import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtifactSessionKey,
  createCommittedArtifactPaneViewModel,
} from './artifact-pane-view-model.js';
import { createArtifactPaneViewModel } from '../../test-support/create-artifact-pane-view-model.js';
import { brandThreadId } from '../../lib/id-brand-helpers.js';

void test('createCommittedArtifactPaneViewModel owns committed artifact source identity assembly', () => {
  const viewModel = createCommittedArtifactPaneViewModel({
    artifactId: 'artifact_1',
    version: 7,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    digest: 'digest-1',
    payload: '# committed',
    contentHash: 'hash-1',
    createdAt: '2026-04-29T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 4,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories/sample',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  });

  assert.deepEqual(viewModel.sourceRef, {
    kind: 'thread-file',
    workingDirectory: 'stories/sample',
    threadId: '00000000-0000-4000-8000-000000000001',
    runId: 'run-1',
    filePath: 'notes/demo.md',
    messageTimestamp: '2026-04-29T00:00:00.000Z',
    artifactId: 'artifact_1',
    artifactVersion: 7,
    persistenceEpoch: 4,
  });
  assert.equal(viewModel.parsed.renderer, 'markdown');
  assert.equal(viewModel.parsed.payload, '# committed');
});

void test('buildArtifactSessionKey prefers committed artifact identity over digest when available', () => {
  assert.equal(
    buildArtifactSessionKey(
      createArtifactPaneViewModel({
        sourceRef: {
          artifactId: 'art_1',
          artifactVersion: 3,
          persistenceEpoch: 2,
        },
      }),
    ),
    'markdown::art_1::3::2::completed',
  );
});

void test('buildArtifactSessionKey falls back to digest and source context for legacy artifacts', () => {
  assert.equal(
    buildArtifactSessionKey(createArtifactPaneViewModel()),
    [
      'markdown',
      'fixture',
      'completed',
      'workspace',
      '00000000-0000-4000-8000-000000000001',
      'run-1',
      'notes/demo.md',
      '2026-04-04T00:00:00.000Z',
    ].join('::'),
  );
});
