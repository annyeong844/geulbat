import assert from 'node:assert/strict';
import test from 'node:test';

import { isProviderNativeCompactionEntryData } from '@geulbat/protocol/threads';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';

import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import {
  TEST_PROVIDER_REQUEST_OPTIONS,
  testRequestMeasurement,
  withThread,
} from '../../../test-support/compaction-loop.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentLoopMemoryPort } from './compaction-loop.js';
import { compactThreadContextNative } from './compaction-run.js';

void test('memory port admits Qwen summary compaction with the same threshold lifecycle as native providers', async () => {
  const contextUsage: ContextUsageUpdatedEventPayload[] = [];
  const qwenOptions = {
    ...TEST_PROVIDER_REQUEST_OPTIONS,
    providerId: 'qwen_token_plan' as const,
    model: 'qwen3.8-max-preview',
  };
  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(97),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: qwenOptions,
  };
  const port = createAgentLoopMemoryPort();
  const firstRound = port.beginContextBudgetRound({
    ...common,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });

  assert.deepEqual(
    await firstRound.onProviderRequestPrepared(testRequestMeasurement(1_000)),
    { kind: 'send' },
  );
  assert.deepEqual(
    await port.compactAfterModelRound({
      ...common,
      contextBudgetRound: firstRound,
      inputTokens: 500_000,
    }),
    {
      kind: 'not_needed',
      reason: 'under_threshold',
    },
  );
  assert.deepEqual(contextUsage, [
    {
      state: 'measured',
      quality: 'unknown',
      modelId: 'qwen3.8-max-preview',
      requestBytes: 1_000,
      contextWindow: 1_000_000,
      thresholdTokens: 850_000,
    },
    {
      state: 'measured',
      quality: 'exact',
      modelId: 'qwen3.8-max-preview',
      inputTokens: 500_000,
      contextWindow: 1_000_000,
      thresholdTokens: 850_000,
      requestBytes: 1_000,
    },
  ]);

  const nearPolicyRound = port.beginContextBudgetRound({
    ...common,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });
  assert.deepEqual(
    await nearPolicyRound.onProviderRequestPrepared(
      testRequestMeasurement(1_800),
    ),
    { kind: 'prepare', reason: 'near_policy' },
  );
  assert.deepEqual(contextUsage.at(-1), {
    state: 'measured',
    quality: 'estimated',
    modelId: 'qwen3.8-max-preview',
    inputTokens: 900_000,
    contextWindow: 1_000_000,
    thresholdTokens: 850_000,
    requestBytes: 1_800,
  });
});

void test('memory port maps every Qwen summary compaction refusal to a stable preparation failure', async (t) => {
  type MemoryPortDependencies = NonNullable<
    Parameters<typeof createAgentLoopMemoryPort>[0]
  >;
  type CompactSummaryResult = Awaited<
    ReturnType<NonNullable<MemoryPortDependencies['compactSummaryThread']>>
  >;
  const cases: Array<{
    name: string;
    result: CompactSummaryResult;
    expected: {
      kind: 'failed';
      reason: string;
      message: string;
    };
  }> = [
    {
      name: 'no summarizable prefix',
      result: { kind: 'no_summarizable_prefix' },
      expected: {
        kind: 'failed',
        reason: 'no_summarizable_prefix',
        message:
          'context compaction cannot replace the current active user turn',
      },
    },
    {
      name: 'retained tail exceeds budget',
      result: { kind: 'tail_exceeds_budget' },
      expected: {
        kind: 'failed',
        reason: 'retained_context_exceeds_budget',
        message:
          'the current active user turn exceeds the retained context budget',
      },
    },
    {
      name: 'invalid summary',
      result: { kind: 'summary_invalid', reason: 'summary_empty' },
      expected: {
        kind: 'failed',
        reason: 'provider_compaction_output_invalid',
        message: 'Qwen summary compaction output is invalid: summary_empty',
      },
    },
    {
      name: 'stale snapshot',
      result: {
        kind: 'stale_snapshot',
        expectedLastEntryId: 'entry-before-compaction',
        actualLastEntryId: 'entry-after-compaction',
      },
      expected: {
        kind: 'failed',
        reason: 'stale_snapshot',
        message: 'context changed while compaction was being committed',
      },
    },
    {
      name: 'empty transcript',
      result: { kind: 'transcript_empty' },
      expected: {
        kind: 'failed',
        reason: 'transcript_empty',
        message: 'context compaction requires a persisted transcript',
      },
    },
  ];
  const qwenOptions = {
    ...TEST_PROVIDER_REQUEST_OPTIONS,
    providerId: 'qwen_token_plan' as const,
    model: 'qwen3.8-max-preview' as const,
  };

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const port = createAgentLoopMemoryPort({
        resolvePolicy: async () => ({
          providerId: 'qwen_token_plan',
          model: qwenOptions.model,
          contextWindow: 100,
          thresholdTokens: 85,
          compactionMethod: 'summary',
          summaryMaxOutputTokens: 20,
          summaryThinkingEnabled: true,
          compactionVersion: 1,
        }),
        compactHistory: async () =>
          assert.fail('Qwen must not use provider-native compaction'),
        compactThread: compactThreadContextNative,
        compactSummaryThread: async () => scenario.result,
      });
      const common = {
        workspaceRoot: '/unused',
        threadId: testThreadId(97_1),
        history: [] as HistoryItem[],
        systemPrompt: 'system',
        tools: [],
        providerAuthRuntime: createProviderAuthRuntimeStore(),
        providerRequestOptions: qwenOptions,
      };
      const round = port.beginContextBudgetRound(common);
      await round.onProviderRequestPrepared(testRequestMeasurement(1_000));

      assert.deepEqual(
        await port.compactAfterModelRound({
          ...common,
          contextBudgetRound: round,
          inputTokens: 85,
        }),
        scenario.expected,
      );
    });
  }
});

void test('memory port contains thrown Qwen summary compaction failures', async () => {
  const qwenOptions = {
    ...TEST_PROVIDER_REQUEST_OPTIONS,
    providerId: 'qwen_token_plan' as const,
    model: 'qwen3.8-max-preview' as const,
  };
  const port = createAgentLoopMemoryPort({
    resolvePolicy: async () => ({
      providerId: 'qwen_token_plan',
      model: qwenOptions.model,
      contextWindow: 100,
      thresholdTokens: 85,
      compactionMethod: 'summary',
      summaryMaxOutputTokens: 20,
      summaryThinkingEnabled: true,
      compactionVersion: 1,
    }),
    compactHistory: async () =>
      assert.fail('Qwen must not use provider-native compaction'),
    compactThread: compactThreadContextNative,
    compactSummaryThread: async () => {
      throw new Error('summary checkpoint unavailable');
    },
  });
  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(97_2),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: qwenOptions,
  };
  const round = port.beginContextBudgetRound(common);
  await round.onProviderRequestPrepared(testRequestMeasurement(1_000));

  assert.deepEqual(
    await port.compactAfterModelRound({
      ...common,
      contextBudgetRound: round,
      inputTokens: 85,
    }),
    {
      kind: 'failed',
      reason: 'provider_compaction_failed',
      message: 'Qwen summary context compaction failed',
    },
  );
});

void test('memory port commits a Qwen summary checkpoint and immediately rebases active history', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'older request',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: 'older answer',
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    const current = await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'current request',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const history: HistoryItem[] = [
      { kind: 'user', text: 'older request' },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: 'older answer',
      },
      { kind: 'user', text: 'current request' },
    ];
    let summaryCalls = 0;
    const qwenOptions = {
      ...TEST_PROVIDER_REQUEST_OPTIONS,
      providerId: 'qwen_token_plan' as const,
      model: 'qwen3.8-max-preview',
    };
    const providerWebSocketSessions = {
      async acquireWebSocket() {
        throw new Error('summary test must not acquire a WebSocket');
      },
      async *streamDurableHttpSseEvents() {
        assert.fail('summary transport is inspected before provider dispatch');
      },
    };
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'qwen_token_plan',
        model: 'qwen3.8-max-preview',
        contextWindow: 100,
        thresholdTokens: 85,
        compactionMethod: 'summary',
        summaryMaxOutputTokens: 20,
        summaryThinkingEnabled: true,
        compactionVersion: 1,
      }),
      compactHistory: async () =>
        assert.fail('Qwen must not use provider-native compaction'),
      compactThread: compactThreadContextNative,
      summarizeQwenHistory: async (input) => {
        summaryCalls += 1;
        assert.deepEqual(input.historyPrefix, history.slice(0, 2));
        assert.equal(input.providerSessionId, threadId);
        assert.equal(input.providerRequestSessions, providerWebSocketSessions);
        return {
          summary: 'Older work was completed.',
          shortSummary: 'Older work completed.',
          summaryTokens: 5,
          providerUsageTelemetry: {
            inputTokens: 70,
            outputTokens: 5,
          },
        };
      },
    });
    const common = {
      workspaceRoot,
      threadId,
      history,
      systemPrompt: 'system',
      tools: [],
      providerWebSocketSessions,
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: qwenOptions,
    };
    const round = port.beginContextBudgetRound(common);
    await round.onProviderRequestPrepared(testRequestMeasurement(1_000));

    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: round,
        inputTokens: 85,
      }),
      {
        kind: 'compacted',
        providerRoundAnchorEntryId: current.entryId,
        providerUsageTelemetry: {
          inputTokens: 70,
          outputTokens: 5,
        },
      },
    );
    assert.equal(summaryCalls, 1);
    assert.equal(history[0]?.kind, 'user');
    if (history[0]?.kind === 'user') {
      assert.match(history[0].text, /Older work was completed/u);
    }
    assert.deepEqual(history.slice(1), [
      { kind: 'user', text: 'current request' },
    ]);
    const checkpoint = (
      await readTranscriptEntries(workspaceRoot, threadId)
    ).at(-1);
    assert.equal(checkpoint?.role, 'compaction');
    if (checkpoint?.role === 'compaction') {
      assert.equal(
        isProviderNativeCompactionEntryData(checkpoint.compactionData),
        false,
      );
      if (
        !isProviderNativeCompactionEntryData(checkpoint.compactionData) &&
        !('kind' in checkpoint.compactionData)
      ) {
        assert.equal(
          checkpoint.compactionData.summary,
          'Older work was completed.',
        );
      }
    }
  });
});
