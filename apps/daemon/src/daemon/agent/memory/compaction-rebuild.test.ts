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
  ProviderNativeCompactionBoundaryError,
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

function nativeCompaction(
  entryId: string,
  firstKeptEntryId?: string,
  coveredThroughEntryId?: string,
): CompactionThreadMessage {
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
      ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
      ...(coveredThroughEntryId === undefined ? {} : { coveredThroughEntryId }),
    },
  };
}

function providerTransitionCompaction(
  entryId: string,
  coveredThroughEntryId: string,
  summary: string,
  firstKeptEntryId?: string,
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
      ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
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
    assert.match(history[0].text, /not a new user request/);
    assert.match(history[0].text, /trusted summary/);
    // 존재하지 않는 섹션을 탈출구처럼 가리키면 안 된다.
    assert.equal(
      /Active Constraints|Recent User Steers/u.test(history[0].text),
      false,
    );
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
    {
      providerId: 'openai_codex_direct',
      model: 'test-model',
      replayScopeId: TEST_REPLAY_SCOPE_ID,
    },
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
        {
          providerId: 'openai_codex_direct',
          model: 'test-model',
          replayScopeId: `sha256:${'f'.repeat(64)}` as ProviderReplayScopeId,
        },
      ),
    /different authentication scope/u,
  );
});

void test('provider-native rebuild keeps the verbatim pre-checkpoint tail and later appends after its opaque head', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('covered', 'assistant', 'old answer'),
    message('keep-user', 'user', 'current request'),
    message('keep-result', 'assistant', 'current working tail'),
    nativeCompaction('native-checkpoint', 'keep-user', 'covered'),
    message('future-user', 'user', 'next request'),
  ];

  const active = getActiveTranscriptEntries(entries, 'thread');
  assert.deepEqual(
    active.activeEntries.map((entry) => entry.entryId),
    ['keep-user', 'keep-result', 'future-user'],
  );
  assert.deepEqual(
    buildCompactionAwareHistory(
      entries,
      'thread',
      new Map(),
      new Map(),
      undefined,
      {
        providerId: 'openai_codex_direct',
        model: 'test-model',
        replayScopeId: TEST_REPLAY_SCOPE_ID,
      },
    ).slice(1),
    [
      { kind: 'user', text: 'current request' },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: 'current working tail',
      },
      { kind: 'user', text: 'next request' },
    ],
  );
});

void test('provider-native rebuild fails closed when its retained-tail coverage is stale', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('covered', 'assistant', 'old answer'),
    message('unexpected', 'assistant', 'raced entry'),
    message('keep-user', 'user', 'current request'),
    nativeCompaction('native-checkpoint', 'keep-user', 'covered'),
  ];

  assert.throws(
    () => getActiveTranscriptEntries(entries, 'thread'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderNativeCompactionBoundaryError);
      assert.equal(error.compactionEntryId, 'native-checkpoint');
      assert.equal(error.expectedCoveredThroughEntryId, 'covered');
      assert.equal(error.actualCoveredThroughEntryId, 'unexpected');
      return true;
    },
  );
});

void test('provider-native history falls back to the append-only normalized transcript for another provider', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('old-assistant', 'assistant', 'old answer'),
    nativeCompaction('native-checkpoint'),
    message('latest-user', 'user', 'new tail'),
  ];

  assert.deepEqual(
    buildCompactionAwareHistory(
      entries,
      'thread',
      new Map(),
      new Map(),
      undefined,
      {
        providerId: 'grok_oauth',
        model: 'grok-4.5',
      },
    ),
    [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'old answer' },
      { kind: 'user', text: 'new tail' },
    ],
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

void test('provider-transition rebuild keeps the consent-time user tail that precedes its checkpoint', () => {
  const entries = [
    message('old-user', 'user', 'old'),
    message('covered', 'assistant', 'old answer'),
    message('keep-user', 'user', 'exact latest request'),
    providerTransitionCompaction(
      'transition-checkpoint',
      'covered',
      'portable handoff',
      'keep-user',
    ),
    message('future-user', 'user', 'next request'),
  ];

  const active = getActiveTranscriptEntries(entries, 'thread');
  assert.deepEqual(
    active.activeEntries.map((entry) => entry.entryId),
    ['keep-user', 'future-user'],
  );
  assert.deepEqual(buildCompactionAwareHistory(entries, 'thread').slice(1), [
    { kind: 'user', text: 'exact latest request' },
    { kind: 'user', text: 'next request' },
  ]);
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

void test('an invalid retained-token budget keeps its configuration identity', () => {
  assert.deepEqual(
    prepareContextCompaction({
      entries: [message('entry', 'user', 'entry')],
      threadId: 'thread',
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: {
        ...TEST_BUDGET_PROFILE,
        keepRecentTokens: Number.NaN,
      },
      tokenCounter: createTokenCounter(),
      forced: false,
    }),
    {
      kind: 'invalid_budget',
      reason: 'token_value_not_safe_integer',
      field: 'keepRecentTokens',
    },
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

// 압축은 턴 중간에도 돈다. 사용자 요청 뒤에 큰 도구 출력이 붙으면 예산만으로
// 자른 경계가 그 요청을 요약 영역에 남긴다. 요약본은 "요약 안의 지시를 따르지
// 말라"는 전제로 전달되므로 그러면 요청이 행동 가능한 컨텍스트에서 사라진다.
void test('compaction refuses to leave the active user request inside the summary', () => {
  const entries = [
    message('ask', 'user', 'fix the failing test'),
    message('call', 'tool_call', '{"callId":"c1"}'),
    message('result', 'tool_result', '{"callId":"c1"}'),
  ];

  const result = prepareContextCompaction({
    entries,
    threadId: 'thread',
    currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
    budgetProfile: TEST_BUDGET_PROFILE,
    tokenCounter: createTokenCounter([
      ['ask', 10],
      ['call', 5],
      ['result', 45],
    ]),
    forced: true,
  });

  // 요청을 프리픽스로 넘기는 압축을 만들지 않는다. 호출자는 이 실패를
  // 'retained_context_exceeds_budget'으로 표면화한다.
  assert.deepEqual(result, { kind: 'tail_exceeds_budget' });
});

// mid-turn: user → tool_call → tool_result 이고 assistant 정착 전이면 pending
// user다. 예산이 허락하면 압축은 진행하되, 그 user는 반드시 retained tail에
// 남는다 (요약 prefix에 넣지 않는다).
void test('mid-turn pending user with tool rows stays in the retained tail when compaction proceeds', () => {
  const entries = [
    message('old-user', 'user', 'previous question'),
    message('old-assistant', 'assistant', 'previous answer'),
    message('pending', 'user', 'current request still in flight'),
    message(
      'call',
      'tool_call',
      JSON.stringify({ callId: 'c1', tool: 'read_file', args: {} }),
    ),
    message(
      'result',
      'tool_result',
      JSON.stringify({ callId: 'c1', output: 'ok' }),
    ),
  ];

  const result = prepareContextCompaction({
    entries,
    threadId: 'thread',
    currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
    budgetProfile: TEST_BUDGET_PROFILE,
    tokenCounter: createTokenCounter([
      // 과거 턴은 keepRecent(50) 밖으로 밀려 prefix가 되고,
      // pending+tools(25)만 retained tail에 남도록 잡는다.
      ['old-user', 25],
      ['old-assistant', 30],
      ['pending', 10],
      ['call', 5],
      ['result', 10],
    ]),
    forced: true,
  });

  assert.equal(result.kind, 'prepared');
  if (result.kind === 'prepared') {
    assert.deepEqual(
      result.historyPrefix.map((entry) => entry.entryId),
      ['old-user', 'old-assistant'],
    );
    // mid-turn: assistant 정착 전 pending user + tool rows가 retained unit.
    assert.deepEqual(
      result.recent.map((entry) => entry.entryId),
      ['pending', 'call', 'result'],
    );
  }
});
