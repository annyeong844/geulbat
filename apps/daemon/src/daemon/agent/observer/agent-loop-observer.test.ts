import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordAgentLoopObserverCompletionGap,
  rehydrateToolLibraryProjectionFromObserverSnapshot,
  type AgentLoopCompletionGapObservation,
  type AgentLoopObserverDiagnostic,
} from './agent-loop-observer.js';
import { createDaemonContext } from '../../context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('observer snapshot projection rehydration fails closed without projection identity', async () => {
  const projectionPort = createDaemonContext().toolLibraryProjection;
  const result = await rehydrateToolLibraryProjectionFromObserverSnapshot({
    snapshot: {
      threadId: testThreadId(5),
      toolSurface: {
        admission: { kind: 'registry_default' },
        definitions: { count: 0, names: [] },
      },
    },
    stateRoot: '/tmp/geulbat-observer-no-projection',
    projectionPort,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'projection_identity_missing',
    message:
      'Agent loop observer snapshot has no tool library projection identity',
  });
});

void test('completion-gap observer failure remains non-authoritative', () => {
  const diagnostics: AgentLoopObserverDiagnostic[] = [];
  const observation: AgentLoopCompletionGapObservation = {
    schemaVersion: 1,
    runId: testRunId('completion-gap-observer-failure'),
    threadId: testThreadId(44),
    source: 'natural',
    obligation: 'approved_plan_execution',
    gapFingerprint: `sha256:${'1'.repeat(64)}`,
    evidenceRevision: `sha256:${'2'.repeat(64)}`,
    repeatCount: 2,
    sameGapAndEvidenceAsPrevious: true,
  };

  recordAgentLoopObserverCompletionGap(
    {
      recordSnapshot() {},
      recordEvent() {},
      recordCompletionGap() {
        throw new Error('observer unavailable');
      },
      recordDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
    observation,
  );

  assert.deepEqual(diagnostics, [
    {
      schemaVersion: 1,
      kind: 'observer_delivery_failed',
      operation: 'record_completion_gap',
    },
  ]);
});
