import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunId } from '@geulbat/protocol/ids';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';

import {
  buildArtifactSessionKey,
  createCommittedArtifactPaneViewModel,
} from './artifact-pane-view-model.js';
import { createArtifactPaneViewModel } from '../../test-support/create-artifact-pane-view-model.js';
import { brandThreadId } from '../../lib/id-brand-helpers.js';
import { resolvePlanRenderingStampProjection } from './artifact-view-model.js';

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
  assert.equal(viewModel.artifact.renderer, 'markdown');
  assert.equal(viewModel.artifact.payload, '# committed');
});

void test('buildArtifactSessionKey uses the protocol-owned committed artifact identity', () => {
  assert.equal(
    buildArtifactSessionKey(
      createArtifactPaneViewModel({
        artifact: {
          artifactId: 'artifact_3',
          version: 3,
          persistenceEpoch: 2,
        },
      }),
    ),
    'markdown::artifact_3::3::2',
  );
});

void test('plan rendering projection distinguishes current, superseded, and historical revisions', () => {
  const stamp = {
    workflowId: 'workflow-1',
    planId: 'plan-1',
    revision: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  } as const;
  const currentSnapshot: PlanningWorkflowSnapshot = {
    state: 'awaiting_approval',
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    intensity: 'visual',
    depth: 'deep',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    ...stamp,
    draft: {
      schemaVersion: 'plan_draft_v1',
      outcome: 'Stamp the rendering',
      steps: [],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
    proposalRunId: assertRunId('run-plan'),
  };

  assert.equal(
    resolvePlanRenderingStampProjection(stamp, currentSnapshot)?.status,
    'current',
  );
  assert.equal(
    resolvePlanRenderingStampProjection(stamp, {
      ...currentSnapshot,
      revision: 2,
      digest: `sha256:${'b'.repeat(64)}`,
    })?.status,
    'superseded',
  );
  assert.equal(
    resolvePlanRenderingStampProjection(stamp, null)?.status,
    'historical',
  );
});
