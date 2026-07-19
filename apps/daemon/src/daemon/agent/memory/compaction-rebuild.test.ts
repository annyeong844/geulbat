import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import type {
  BudgetProfile,
  CompactionThreadMessage,
  ThreadMessage,
  ThreadMessageRole,
} from '@geulbat/protocol/threads';

import {
  buildCompactionAwareHistory,
  CompactionBoundaryUnresolvedError,
  CompactionTokenCountError,
  getActiveTranscriptEntries,
  prepareContextCompaction,
  ProviderTransitionCompactionBoundaryError,
} from './compaction-rebuild.js';

const TEST_TIMESTAMP = '2026-07-16T00:00:00.000Z';
const TEST_REPLAY_SCOPE_ID = `sha256:${'e'.repeat(
  64,
)}` as ProviderReplayScopeId;
const TEST_BUDGET_PROFILE: BudgetProfile = {
  model: 'test-model',
  contextWindow: 100,
  reserveTokens: 10,
  thresholdTokens: 90,
  keepRecentTokens: 50,
  summaryBudgetTokens: 20,
  requestOverheadTokens: 10,
  requestProfileHash: 'test-profile',
  compactionVersion: 1,
};

function message(
  entryId: string,
  role: Exclude<ThreadMessageRole, 'compaction'>,
  content: string,
): ThreadMessage {
  return { entryId, role, content, timestamp: TEST_TIMESTAMP };
}

function compaction(
  entryId: string,
  firstKeptEntryId: string,
  summary: string,
): CompactionThreadMessage {
  return {
    entryId,
    role: 'compaction',
    content: '',
    timestamp: TEST_TIMESTAMP,
    compactionData: {
      summary,
      shortSummary: summary,
      firstKeptEntryId,
      tokensBefore: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
    },
  };
}

function nativeCompaction(entryId: string): CompactionThreadMessage {
  return {
    entryId,
    role: 'compaction',
    content: '',
    timestamp: TEST_TIMESTAMP,
    compactionData: {
      kind: 'provider_native',
      providerId: 'openai_codex_direct',
      model: 'test-model',
      replayScopeId: TEST_REPLAY_SCOPE_ID,
      output: [
        {
          type: 'compaction',
          encrypted_content: 'encrypted-checkpoint',
        },
      ],
      tokensBefore: TEST_BUDGET_PROFILE.thresholdTokens,
      contextWindow: TEST_BUDGET_PROFILE.contextWindow,
      thresholdTokens: TEST_BUDGET_PROFILE.thresholdTokens,
    },
  };
}

function providerTransitionCompaction(
  entryId: string,
  coveredThroughEntryId: string,
  summary: string,
): CompactionThreadMessage {
  return {
    entryId,
    role: 'compaction',
    content: '',
    timestamp: TEST_TIMESTAMP,
    compactionData: {
      kind: 'provider_transition',
      sourceProviderId: 'grok_oauth',
      sourceModel: 'grok-4.5',
      targetProviderId: 'openai_codex_direct',
      targetModel: 'gpt-5.6-sol',
      summary,
      coveredThroughEntryId,
    },
  };
}

void test('uncompacted history preserves the existing transcript mapping', () => {
  const entries = [
    message('user', 'user', 'hello'),
    message('assistant', 'assistant', 'hi'),
  ];

  assert.deepEqual(buildCompactionAwareHistory(entries, 'thread'), [
    { kind: 'user', text: 'hello' },
    { kind: 'assistant', phase: 'final_answer', text: 'hi' },
  ]);
});

void test('history rebuild prepends the summary and retains the real tail', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('old-assistant', 'assistant', 'old answer'),
    message('keep-user', 'user', 'keep'),
    compaction('checkpoint', 'keep-user', 'trusted summary'),
    message('latest-assistant', 'assistant', 'latest'),
  ];

  const history = buildCompactionAwareHistory(entries, 'thread');

  assert.equal(history.length, 3);
  assert.equal(history[0]?.kind, 'user');
  if (history[0]?.kind === 'user') {
    assert.match(history[0].text, /system-generated context/);
    assert.match(history[0].text, /trusted summary/);
  }
  assert.deepEqual(history.slice(1), [
    { kind: 'user', text: 'keep' },
    { kind: 'assistant', phase: 'final_answer', text: 'latest' },
  ]);
});

void test('provider-native rebuild replaces the prefix and keeps only post-checkpoint tail', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('old-assistant', 'assistant', 'old answer'),
    nativeCompaction('native-checkpoint'),
    message('latest-user', 'user', 'new tail'),
  ];

  const active = getActiveTranscriptEntries(entries, 'thread');
  const history = buildCompactionAwareHistory(
    entries,
    'thread',
    new Map(),
    new Map(),
    undefined,
    TEST_REPLAY_SCOPE_ID,
  );

  assert.equal(active.latestCompactionEntryId, 'native-checkpoint');
  assert.deepEqual(
    active.activeEntries.map((entry) => entry.entryId),
    ['latest-user'],
  );
  assert.deepEqual(history, [
    {
      kind: 'provider_native_compaction',
      providerId: 'openai_codex_direct',
      model: 'test-model',
      providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
      output: [
        {
          type: 'compaction',
          encrypted_content: 'encrypted-checkpoint',
        },
      ],
    },
    { kind: 'user', text: 'new tail' },
  ]);
  assert.throws(
    () =>
      buildCompactionAwareHistory(
        entries,
        'thread',
        new Map(),
        new Map(),
        undefined,
        `sha256:${'f'.repeat(64)}` as ProviderReplayScopeId,
      ),
    /different authentication scope/u,
  );
});

void test('provider-transition rebuild uses the portable summary and only the post-consent tail', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('covered', 'assistant', 'old answer'),
    providerTransitionCompaction(
      'transition-checkpoint',
      'covered',
      'portable handoff',
    ),
    message('latest-user', 'user', 'new tail'),
  ];

  const active = getActiveTranscriptEntries(entries, 'thread');
  const history = buildCompactionAwareHistory(entries, 'thread');

  assert.equal(active.previousSummary, 'portable handoff');
  assert.equal(active.latestCompactionEntryId, 'transition-checkpoint');
  assert.deepEqual(
    active.activeEntries.map((entry) => entry.entryId),
    ['latest-user'],
  );
  assert.equal(history[0]?.kind, 'user');
  if (history[0]?.kind === 'user') {
    assert.match(history[0].text, /portable handoff/u);
  }
  assert.deepEqual(history.slice(1), [{ kind: 'user', text: 'new tail' }]);
});

void test('provider-transition rebuild fails closed when its covered snapshot is not adjacent', () => {
  const entries = [
    message('covered', 'user', 'old'),
    message('unexpected', 'assistant', 'raced entry'),
    providerTransitionCompaction(
      'transition-checkpoint',
      'covered',
      'stale handoff',
    ),
  ];

  assert.throws(
    () => getActiveTranscriptEntries(entries, 'thread'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTransitionCompactionBoundaryError);
      assert.equal(error.compactionEntryId, 'transition-checkpoint');
      assert.equal(error.expectedCoveredThroughEntryId, 'covered');
      assert.equal(error.actualCoveredThroughEntryId, 'unexpected');
      return true;
    },
  );
});

void test('the latest checkpoint keeps its earlier tail and filters every marker', () => {
  const entries = [
    message('old', 'user', 'old'),
    message('first-keep', 'user', 'first keep'),
    compaction('first-checkpoint', 'first-keep', 'first summary'),
    message('second-keep', 'assistant', 'second keep'),
    compaction('second-checkpoint', 'first-keep', 'second summary'),
    message('latest', 'user', 'latest'),
  ];

  const active = getActiveTranscriptEntries(entries, 'thread');

  assert.equal(active.previousSummary, 'second summary');
  assert.equal(active.latestCompactionEntryId, 'second-checkpoint');
  assert.deepEqual(
    active.activeEntries.map((entry) => entry.entryId),
    ['first-keep', 'second-keep', 'latest'],
  );
});

void test('an unresolved boundary fails closed with diagnostic identity', () => {
  const entries = [
    compaction('checkpoint', 'missing', 'summary'),
    message('latest', 'user', 'latest'),
  ];

  assert.throws(
    () => getActiveTranscriptEntries(entries, 'thread'),
    (error: unknown) => {
      assert.ok(error instanceof CompactionBoundaryUnresolvedError);
      assert.equal(error.threadId, 'thread');
      assert.equal(error.compactionEntryId, 'checkpoint');
      assert.equal(error.firstKeptEntryId, 'missing');
      assert.equal(error.reason, 'missing_first_kept_entry');
      return true;
    },
  );
});

void test('active tool output bytes survive compaction without pruning', () => {
  const storedOutput = JSON.stringify({
    status: 'exit',
    stdout: 'complete output',
    outputRef: 'tool-output:thread/run/call',
  });
  const entries = [
    message('old', 'user', 'old'),
    message(
      'tool-call',
      'tool_call',
      JSON.stringify({
        id: 'function-call',
        callId: 'call',
        tool: 'exec_command',
        args: { cmd: 'test' },
      }),
    ),
    message(
      'tool-result',
      'tool_result',
      JSON.stringify({ callId: 'call', output: storedOutput }),
    ),
    compaction('checkpoint', 'tool-call', 'summary'),
  ];

  const history = buildCompactionAwareHistory(entries, 'thread');
  const output = history.find((item) => item.kind === 'function_call_output');

  assert.equal(output?.kind, 'function_call_output');
  if (output?.kind === 'function_call_output') {
    assert.equal(output.output, storedOutput);
  }
});

void test('prepare is a no-op below the explicit threshold', () => {
  const entries = [
    message('old', 'user', 'old'),
    message('latest', 'assistant', 'latest'),
  ];

  assert.deepEqual(
    prepareContextCompaction({
      entries,
      threadId: 'thread',
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens - 1,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: createTokenCounter(),
      forced: false,
    }),
    { kind: 'noop', reason: 'under_threshold' },
  );
});

void test('forced prepare bypasses only the trigger and selects a real prefix', () => {
  const entries = [
    message('old', 'user', 'old'),
    message('keep', 'assistant', 'keep'),
  ];
  const result = prepareContextCompaction({
    entries,
    threadId: 'thread',
    currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens - 1,
    budgetProfile: TEST_BUDGET_PROFILE,
    tokenCounter: createTokenCounter([
      ['old', 60],
      ['keep', 40],
    ]),
    forced: true,
  });

  assert.equal(result.kind, 'prepared');
  if (result.kind === 'prepared') {
    assert.deepEqual(
      result.historyPrefix.map((entry) => entry.entryId),
      ['old'],
    );
    assert.deepEqual(
      result.recent.map((entry) => entry.entryId),
      ['keep'],
    );
    assert.equal(result.firstKeptEntryId, 'keep');
  }
});

void test('recompaction can compress only the previous summary while retaining the full tail', () => {
  const entries = [
    message('old', 'user', 'old'),
    message('keep', 'assistant', 'keep'),
    compaction('checkpoint', 'keep', 'previous summary'),
  ];
  const result = prepareContextCompaction({
    entries,
    threadId: 'thread',
    currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
    budgetProfile: TEST_BUDGET_PROFILE,
    tokenCounter: createTokenCounter([['keep', 40]]),
    forced: false,
  });

  assert.equal(result.kind, 'prepared');
  if (result.kind === 'prepared') {
    assert.equal(result.previousSummary, 'previous summary');
    assert.deepEqual(result.historyPrefix, []);
    assert.deepEqual(
      result.recent.map((entry) => entry.entryId),
      ['keep'],
    );
    assert.equal(result.prefixTokens, 0);
    assert.equal(result.retainedTokens, 40);
  }
});

void test('parallel tool calls and results form one uncuttable retained unit', () => {
  const entries = [
    message('old', 'user', 'old'),
    message(
      'call-a',
      'tool_call',
      JSON.stringify({ callId: 'a', tool: 'read_file', args: {} }),
    ),
    message(
      'call-b',
      'tool_call',
      JSON.stringify({ callId: 'b', tool: 'read_file', args: {} }),
    ),
    message(
      'result-a',
      'tool_result',
      JSON.stringify({ callId: 'a', output: 'a' }),
    ),
    message(
      'result-b',
      'tool_result',
      JSON.stringify({ callId: 'b', output: 'b' }),
    ),
    message('latest', 'user', 'latest'),
  ];
  const result = prepareContextCompaction({
    entries,
    threadId: 'thread',
    currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
    budgetProfile: TEST_BUDGET_PROFILE,
    tokenCounter: createTokenCounter([
      ['old', 50],
      ['call-a', 10],
      ['call-b', 10],
      ['result-a', 10],
      ['result-b', 10],
      ['latest', 10],
    ]),
    forced: false,
  });

  assert.equal(result.kind, 'prepared');
  if (result.kind === 'prepared') {
    assert.deepEqual(
      result.recent.map((entry) => entry.entryId),
      ['call-a', 'call-b', 'result-a', 'result-b', 'latest'],
    );
  }
});

void test('an orphan tool result makes prepare fail closed', () => {
  const entries = [
    message(
      'orphan',
      'tool_result',
      JSON.stringify({ callId: 'missing-call', output: 'result' }),
    ),
    message('latest', 'user', 'latest'),
  ];

  assert.deepEqual(
    prepareContextCompaction({
      entries,
      threadId: 'thread',
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: createTokenCounter(),
      forced: false,
    }),
    {
      kind: 'invalid_interaction_boundary',
      reason: 'orphan_tool_result',
      callId: 'missing-call',
    },
  );
});

void test('an invalid host token count throws before a checkpoint can be prepared', () => {
  const entries = [message('entry', 'user', 'entry')];

  assert.throws(
    () =>
      prepareContextCompaction({
        entries,
        threadId: 'thread',
        currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
        budgetProfile: TEST_BUDGET_PROFILE,
        tokenCounter: {
          countTranscriptEntryTokens() {
            return Number.NaN;
          },
        },
        forced: false,
      }),
    CompactionTokenCountError,
  );
});

function createTokenCounter(
  counts: ReadonlyArray<readonly [string, number]> = [],
): { countTranscriptEntryTokens(entry: ThreadMessage): number } {
  const countsByEntryId = new Map(counts);
  return {
    countTranscriptEntryTokens(entry) {
      return countsByEntryId.get(entry.entryId) ?? 1;
    },
  };
}
