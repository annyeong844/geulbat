import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCompactionEntryData,
  isThreadDeleteResponse,
  isThreadDetailDiagnostics,
  isThreadDetailResponse,
  isThreadMessage,
  isThreadSummary,
  THREAD_MESSAGE_ROLES,
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

void test('compaction role exists and entry data validates', () => {
  assert.equal(THREAD_MESSAGE_ROLES.includes('compaction'), true);
  assert.equal(
    isCompactionEntryData({
      summary: 'Older turns summarized.',
      shortSummary: 'Summary.',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 1200,
      budgetProfile: {
        model: 'model-a',
        contextWindow: 8000,
        reserveTokens: 1000,
        thresholdTokens: 7000,
        keepRecentTokens: 2000,
        summaryBudgetTokens: 1000,
        requestOverheadTokens: 100,
        requestProfileHash: 'sha256:test',
        compactionVersion: 1,
      },
      fileOps: {
        readFiles: ['README.md'],
        modifiedFiles: ['draft.md'],
        createdFiles: ['new.md'],
        deletedFiles: [],
        renamedFiles: [{ from: 'old.md', to: 'new.md' }],
      },
    }),
    true,
  );
});

void test('compaction entry data rejects missing required fields', () => {
  assert.equal(
    isCompactionEntryData({
      summary: 'Older turns summarized.',
      shortSummary: 'Summary.',
      tokensBefore: 1200,
    }),
    false,
  );
  assert.equal(
    isCompactionEntryData({
      summary: 'Older turns summarized.',
      shortSummary: 'Summary.',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 1200,
      budgetProfile: null,
    }),
    false,
  );
});

void test('isThreadMessage enforces role-specific compaction data', () => {
  const base = {
    entryId: 'entry-1',
    content: 'hello',
    timestamp: '2026-06-28T00:00:00.000Z',
  };
  const compactionData = {
    summary: 'Older turns summarized.',
    shortSummary: 'Summary.',
    firstKeptEntryId: 'entry-1',
    tokensBefore: 1200,
    budgetProfile: {
      model: 'model-a',
      contextWindow: 8000,
      reserveTokens: 1000,
      thresholdTokens: 7000,
      keepRecentTokens: 2000,
      summaryBudgetTokens: 1000,
      requestOverheadTokens: 100,
      requestProfileHash: 'sha256:test',
      compactionVersion: 1,
    },
  };

  assert.equal(
    isThreadMessage({ ...base, role: 'compaction', compactionData }),
    true,
  );
  assert.equal(
    isThreadMessage({
      ...base,
      role: 'compaction',
      compactionData: undefined,
    }),
    false,
  );
  assert.equal(
    isThreadMessage({
      ...base,
      role: 'compaction',
      compactionData: { summary: 'incomplete' },
    }),
    false,
  );
  assert.equal(
    isThreadMessage({ ...base, role: 'user', compactionData }),
    false,
  );
});
