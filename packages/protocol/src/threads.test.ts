import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isThreadDeleteResponse,
  isThreadDetailDiagnostics,
  isThreadDetailResponse,
  isThreadSummary,
} from './threads.js';

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('thread response guards require canonical project ids', () => {
  assert.equal(
    isThreadSummary({
      threadId: VALID_THREAD_ID,
      projectId: 'workspace',
      lastUpdated: '2026-04-11T00:00:00.000Z',
      messageCount: 1,
    }),
    true,
  );
  assert.equal(
    isThreadSummary({
      threadId: VALID_THREAD_ID,
      projectId: '../escape',
      lastUpdated: '2026-04-11T00:00:00.000Z',
      messageCount: 1,
    }),
    false,
  );

  assert.equal(
    isThreadDetailResponse({
      threadId: VALID_THREAD_ID,
      projectId: 'workspace',
      snapshotVersion: '2026-04-11T00:00:00.000Z',
      messages: [],
      diagnostics: {
        unlinkedPersistedArtifactCount: 1,
        missingLinkedArtifactCount: 0,
      },
    }),
    true,
  );
  assert.equal(
    isThreadDetailResponse({
      threadId: VALID_THREAD_ID,
      projectId: '../escape',
      snapshotVersion: '2026-04-11T00:00:00.000Z',
      messages: [],
    }),
    false,
  );

  assert.equal(
    isThreadDetailDiagnostics({
      unlinkedPersistedArtifactCount: 1,
      missingLinkedArtifactCount: 2,
    }),
    true,
  );
  assert.equal(
    isThreadDetailDiagnostics({
      unlinkedPersistedArtifactCount: -1,
      missingLinkedArtifactCount: 0,
    }),
    false,
  );

  assert.equal(
    isThreadDeleteResponse({
      ok: true,
      threadId: VALID_THREAD_ID,
      projectId: 'workspace',
    }),
    true,
  );
  assert.equal(
    isThreadDeleteResponse({
      ok: true,
      threadId: VALID_THREAD_ID,
      projectId: '../escape',
    }),
    false,
  );
});
