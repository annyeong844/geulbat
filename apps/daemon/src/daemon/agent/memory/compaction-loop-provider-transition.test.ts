import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';

import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import {
  TEST_PROVIDER_REQUEST_OPTIONS,
  TEST_REPLAY_SCOPE_ID,
  testRequestMeasurement,
  withThread,
} from '../../../test-support/compaction-loop.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentLoopMemoryPort } from './compaction-loop.js';
import { prepareProviderTransitionCompaction } from './provider-transition-compaction.js';
import {
  compactThreadContextForProviderTransition,
  compactThreadContextNative,
} from './compaction-run.js';

void test('memory port keeps calibration and policy separate when the model changes', async () => {
  const contextUsage: ContextUsageUpdatedEventPayload[] = [];
  const port = createAgentLoopMemoryPort({
    resolvePolicy: async (input) =>
      input.providerRequestOptions.providerId === 'grok_oauth'
        ? {
            providerId: 'grok_oauth',
            model: input.providerRequestOptions.model,
            contextWindow: 1_000,
            thresholdTokens: 900,
          }
        : {
            providerId: 'openai_codex_direct',
            model: input.providerRequestOptions.model,
            contextWindow: 1_000,
            thresholdTokens: 900,
            supportsParallelToolCalls: true,
          },
    compactHistory: async () => {
      throw new Error('must not compact');
    },
    compactThread: compactThreadContextNative,
    measureHistoryBytes: () => 100,
  });
  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(94),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
  };
  const openAiRound = port.beginContextBudgetRound({
    ...common,
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });
  await openAiRound.onProviderRequestPrepared(testRequestMeasurement(100));
  await port.compactAfterModelRound({
    ...common,
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    contextBudgetRound: openAiRound,
    inputTokens: 50,
  });
  assert.deepEqual(openAiRound.getToolResultContextBudget?.(), {
    kind: 'available',
    quality: 'exact',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 1_700,
  });

  const grokOptions = {
    ...TEST_PROVIDER_REQUEST_OPTIONS,
    providerId: 'grok_oauth' as const,
    model: 'grok-4.5',
  };
  const grokRound = port.beginContextBudgetRound({
    ...common,
    providerRequestOptions: grokOptions,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });
  await grokRound.onProviderRequestPrepared(testRequestMeasurement(100));
  assert.deepEqual(grokRound.getToolResultContextBudget?.(), {
    kind: 'unknown',
    modelKey: 'grok_oauth\0grok-4.5',
    reason: 'usage_unavailable',
  });

  const resumedOpenAiRound = port.beginContextBudgetRound({
    ...common,
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });
  await resumedOpenAiRound.onProviderRequestPrepared(
    testRequestMeasurement(200),
  );
  assert.deepEqual(resumedOpenAiRound.getToolResultContextBudget?.(), {
    kind: 'available',
    quality: 'estimated',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 1_700,
  });

  assert.deepEqual(contextUsage.slice(-2), [
    {
      state: 'measured',
      quality: 'unknown',
      modelId: 'grok-4.5',
      requestBytes: 100,
      contextWindow: 1_000,
      thresholdTokens: 900,
    },
    {
      state: 'measured',
      quality: 'estimated',
      modelId: 'gpt-test',
      inputTokens: 100,
      contextWindow: 1_000,
      thresholdTokens: 900,
      requestBytes: 200,
    },
  ]);
});

void test('memory port rebuilds target history only after a committed provider handoff', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const history: HistoryItem[] = [{ kind: 'user', text: 'current request' }];
    const rebuilt: HistoryItem[] = [
      { kind: 'user', text: 'portable handoff' },
      { kind: 'user', text: 'current request' },
    ];
    const providerWebSocketSessions = {
      async acquireWebSocket() {
        throw new Error('websocket transport must not be reached by the test');
      },
    };
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => {
        throw new Error('native policy must not be resolved');
      },
      compactHistory: async () => {
        throw new Error('native compaction must not run');
      },
      compactThread: compactThreadContextNative,
      async prepareTransition(args) {
        assert.deepEqual(args.source, {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        });
        assert.deepEqual(args.target, {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        });
        assert.equal(args.reasoningEffort, 'high');
        return { kind: 'compacted', compactionEntryId: 'handoff-entry' };
      },
      async loadHistory(
        loadedWorkspaceRoot,
        loadedThreadId,
        prompt,
        providerTarget,
      ) {
        assert.equal(loadedWorkspaceRoot, workspaceRoot);
        assert.equal(loadedThreadId, threadId);
        assert.equal(prompt, 'current request');
        assert.deepEqual(providerTarget, {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
          replayScopeId: TEST_REPLAY_SCOPE_ID,
        });
        return rebuilt;
      },
    });

    const recovered = await port.recoverProviderTransitionAfterOverflow?.({
      workspaceRoot,
      threadId,
      prompt: 'current request',
      history,
      source: { providerId: 'grok_oauth', model: 'grok-4.5' },
      target: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-luna',
      },
      sourceReasoningEffort: 'high',
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerWebSocketSessions,
      providerRequestOptions: {
        ...TEST_PROVIDER_REQUEST_OPTIONS,
        model: 'gpt-5.6-luna',
      },
      targetReplayScopeId: TEST_REPLAY_SCOPE_ID,
    });

    assert.equal(recovered, true);
    assert.deepEqual(history, rebuilt);
  });
});

void test('memory port does not repeat a provider handoff already committed before restart', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const covered = await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: 'older answer',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    const retained = await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'current request',
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'compaction',
      content: '',
      timestamp: '2026-07-17T00:00:02.000Z',
      compactionData: {
        kind: 'provider_transition',
        sourceProviderId: 'grok_oauth',
        sourceModel: 'grok-4.5',
        targetProviderId: 'openai_codex_direct',
        targetModel: 'gpt-5.6-luna',
        summary: 'portable handoff',
        coveredThroughEntryId: covered.entryId,
        firstKeptEntryId: retained.entryId,
      },
    });
    let prepareCalls = 0;
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => {
        throw new Error('native policy must not be resolved');
      },
      compactHistory: async () => {
        throw new Error('native compaction must not run');
      },
      compactThread: compactThreadContextNative,
      async prepareTransition() {
        prepareCalls += 1;
        return { kind: 'compacted', compactionEntryId: 'unexpected' };
      },
      async loadHistory() {
        throw new Error('history must not be rebuilt after a second overflow');
      },
    });

    const recovered = await port.recoverProviderTransitionAfterOverflow?.({
      workspaceRoot,
      threadId,
      prompt: 'current request',
      history: [{ kind: 'user', text: 'current request' }],
      source: { providerId: 'grok_oauth', model: 'grok-4.5' },
      target: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-luna',
      },
      sourceReasoningEffort: 'high',
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerWebSocketSessions: {
        async acquireWebSocket() {
          throw new Error('websocket must not be acquired');
        },
      },
      providerRequestOptions: {
        ...TEST_PROVIDER_REQUEST_OPTIONS,
        model: 'gpt-5.6-luna',
      },
    });

    assert.equal(recovered, false);
    assert.equal(prepareCalls, 0);
  });
});

void test('provider transition admits a same-provider model change for portable preparation', async () => {
  let compactCalls = 0;
  const result = await prepareProviderTransitionCompaction(
    {
      workspaceRoot: '/workspace',
      threadId: testThreadId(93),
      source: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-sol',
      },
      target: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-luna',
      },
      reasoningEffort: 'high',
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerWebSocketSessions: {
        async acquireWebSocket() {
          throw new Error('websocket must not be acquired');
        },
      },
      providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    },
    {
      async *callModel() {
        throw new Error('empty transcript must not call the source model');
      },
      async compactThread(args) {
        compactCalls += 1;
        assert.equal(args.sourceProviderId, 'openai_codex_direct');
        assert.equal(args.sourceModel, 'gpt-5.6-sol');
        assert.equal(args.targetProviderId, 'openai_codex_direct');
        assert.equal(args.targetModel, 'gpt-5.6-luna');
        return { kind: 'transcript_empty' };
      },
      async loadHistory() {
        throw new Error('empty transcript must not load source history');
      },
      async resolveReplayScope() {
        return TEST_REPLAY_SCOPE_ID;
      },
    },
  );

  assert.deepEqual(result, {
    kind: 'not_needed',
    reason: 'transcript_empty',
  });
  assert.equal(compactCalls, 1);
});

void test('provider transition uses the source provider and commits only its portable summary', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'inspect the provider boundary',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: 'the provider boundary is mapped',
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'continue this work',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const before = await readTranscriptEntries(workspaceRoot, threadId);
    const providerWebSocketSessions = {
      async acquireWebSocket() {
        throw new Error('websocket transport must not be reached by the test');
      },
    };

    const result = await prepareProviderTransitionCompaction(
      {
        workspaceRoot,
        threadId,
        source: { providerId: 'grok_oauth', model: 'grok-4.5' },
        target: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-sol',
        },
        reasoningEffort: 'high',
        providerAuthRuntime: createProviderAuthRuntimeStore(),
        providerWebSocketSessions,
        providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
      },
      {
        async *callModel(input) {
          assert.equal(input.providerRequestOptions.providerId, 'grok_oauth');
          assert.equal(input.providerRequestOptions.model, 'grok-4.5');
          assert.equal(input.providerRequestOptions.reasoning.effort, 'high');
          assert.equal(input.providerReplayScopeId, TEST_REPLAY_SCOPE_ID);
          assert.equal(input.tools?.length, 0);
          yield {
            type: 'text_delta',
            phase: 'final_answer',
            text: 'portable source-provider handoff',
          };
          yield {
            type: 'done',
            providerUsageTelemetry: { inputTokens: 300_000 },
          };
        },
        compactThread: compactThreadContextForProviderTransition,
        async loadHistory(
          _workspaceRoot,
          _threadId,
          prompt,
          providerTarget,
          throughEntryId,
        ) {
          assert.match(prompt, /openai_codex_direct\/gpt-5\.6-sol/u);
          assert.deepEqual(providerTarget, {
            providerId: 'grok_oauth',
            model: 'grok-4.5',
            replayScopeId: TEST_REPLAY_SCOPE_ID,
          });
          assert.equal(throughEntryId, before[1]?.entryId);
          return [
            { kind: 'user', text: 'inspect the provider boundary' },
            {
              kind: 'assistant',
              phase: 'final_answer',
              text: 'the provider boundary is mapped',
            },
            { kind: 'user', text: prompt },
          ];
        },
        async resolveReplayScope() {
          return TEST_REPLAY_SCOPE_ID;
        },
      },
    );

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    const checkpoint = stored.at(-1);
    assert.equal(checkpoint?.role, 'compaction');
    if (checkpoint?.role === 'compaction') {
      assert.deepEqual(checkpoint.compactionData, {
        kind: 'provider_transition',
        sourceProviderId: 'grok_oauth',
        sourceModel: 'grok-4.5',
        targetProviderId: 'openai_codex_direct',
        targetModel: 'gpt-5.6-sol',
        summary: 'portable source-provider handoff',
        coveredThroughEntryId: before[1]?.entryId,
        firstKeptEntryId: before[2]?.entryId,
        inputTokens: 300_000,
      });
    }
  });
});
