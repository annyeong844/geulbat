import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCompactionEntryData,
  isPrepareProviderTransitionRequest,
  isPrepareProviderTransitionResponse,
  isProviderNativeCompactionEntryData,
  isProviderTransitionCompactionEntryData,
  isThreadBranchResponse,
  isThreadDeleteResponse,
  isThreadDetailDiagnostics,
  isThreadDetailResponse,
  isThreadMessage,
  isThreadSummary,
  THREAD_MESSAGE_ROLES,
} from './threads.js';

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('thread response guards validate Home thread identities without project ownership', () => {
  assert.equal(
    isThreadSummary({
      threadId: VALID_THREAD_ID,
      lastUpdated: '2026-04-11T00:00:00.000Z',
      messageCount: 1,
    }),
    true,
  );
  assert.equal(
    isThreadSummary({
      threadId: '../escape',
      lastUpdated: '2026-04-11T00:00:00.000Z',
      messageCount: 1,
    }),
    false,
  );

  assert.equal(
    isThreadDetailResponse({
      threadId: VALID_THREAD_ID,
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
      threadId: '../escape',
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
    }),
    true,
  );
  assert.equal(
    isThreadDeleteResponse({
      ok: true,
      threadId: '../escape',
    }),
    false,
  );

  assert.equal(
    isThreadBranchResponse({
      ok: true,
      threadId: VALID_THREAD_ID,
      sourceThreadId: '22222222-2222-4222-8222-222222222222',
      copiedMessageCount: 2,
    }),
    true,
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

void test('provider-native compaction requires pinned, replayable encrypted output', () => {
  const native = {
    kind: 'provider_native',
    providerId: 'openai_codex_direct',
    model: 'model-a',
    output: [
      {
        type: 'compaction',
        encrypted_content: 'encrypted-checkpoint',
      },
    ],
    tokensBefore: 7200,
    contextWindow: 8000,
    thresholdTokens: 7000,
  };

  assert.equal(isProviderNativeCompactionEntryData(native), true);
  assert.equal(isCompactionEntryData(native), true);
  assert.equal(
    isProviderNativeCompactionEntryData({
      ...native,
      output: [
        {
          type: 'compaction_summary',
          encrypted_content: 'encrypted-checkpoint',
        },
      ],
    }),
    true,
  );
  assert.equal(
    isProviderNativeCompactionEntryData({
      ...native,
      output: [{ type: 'message', role: 'user', content: [] }],
    }),
    false,
  );
  assert.equal(
    isProviderNativeCompactionEntryData({
      ...native,
      output: [
        {
          type: 'unknown_compaction',
          encrypted_content: 'encrypted-checkpoint',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isProviderNativeCompactionEntryData({
      ...native,
      thresholdTokens: native.contextWindow + 1,
    }),
    false,
  );
});

void test('provider-transition compaction is readable, cross-provider, and snapshot-pinned', () => {
  const transition = {
    kind: 'provider_transition',
    sourceProviderId: 'grok_oauth',
    sourceModel: 'grok-4.5',
    targetProviderId: 'openai_codex_direct',
    targetModel: 'gpt-5.6-sol',
    summary: 'Portable handoff.',
    coveredThroughEntryId: 'entry-7',
    inputTokens: 300_000,
  };

  assert.equal(isProviderTransitionCompactionEntryData(transition), true);
  assert.equal(isCompactionEntryData(transition), true);
  assert.equal(
    isProviderTransitionCompactionEntryData({
      ...transition,
      targetProviderId: transition.sourceProviderId,
    }),
    false,
  );
  assert.equal(
    isProviderTransitionCompactionEntryData({
      ...transition,
      coveredThroughEntryId: '',
    }),
    false,
  );
});

void test('provider-transition request and response guards keep selection transactional', () => {
  const request = {
    sourceModelId: 'grok-4.5',
    targetModelId: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  };
  assert.equal(isPrepareProviderTransitionRequest(request), true);
  assert.equal(
    isPrepareProviderTransitionRequest({
      ...request,
      targetModelId: 'unknown-model',
    }),
    false,
  );
  assert.equal(
    isPrepareProviderTransitionResponse({
      ok: true,
      status: 'compacted',
      threadId: VALID_THREAD_ID,
      sourceModelId: request.sourceModelId,
      targetModelId: request.targetModelId,
      compactionEntryId: 'entry-8',
    }),
    true,
  );
  assert.equal(
    isPrepareProviderTransitionResponse({
      ok: true,
      status: 'compacted',
      threadId: VALID_THREAD_ID,
      sourceModelId: request.sourceModelId,
      targetModelId: request.targetModelId,
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

void test('isThreadDetailResponse rejects internal compaction entries', () => {
  assert.equal(
    isThreadDetailResponse({
      threadId: VALID_THREAD_ID,
      snapshotVersion: '2026-06-28T00:00:00.000Z',
      messages: [
        {
          entryId: 'entry-compaction',
          role: 'compaction',
          content: 'internal provider checkpoint',
          timestamp: '2026-06-28T00:00:00.000Z',
          compactionData: {
            kind: 'provider_native',
            providerId: 'openai_codex_direct',
            model: 'model-a',
            output: [
              {
                type: 'compaction',
                encrypted_content: 'must-not-be-public',
              },
            ],
            tokensBefore: 7200,
            contextWindow: 8000,
            thresholdTokens: 7000,
          },
        },
      ],
    }),
    false,
  );
});
