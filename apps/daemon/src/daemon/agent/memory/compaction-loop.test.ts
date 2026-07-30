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
  TEST_REPLAY_SCOPE_ID,
  testRequestMeasurement,
  withThread,
} from '../../../test-support/compaction-loop.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentLoopMemoryPort } from './compaction-loop.js';
import { compactThreadContextNative } from './compaction-run.js';

void test('memory port derives the tool-result allowance from active policy and post-model history growth', async () => {
  let currentHistoryBytes = 400;
  const port = createAgentLoopMemoryPort({
    resolvePolicy: async () => ({
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      contextWindow: 1_000,
      thresholdTokens: 900,
      supportsParallelToolCalls: true,
    }),
    compactHistory: async () => {
      throw new Error('must not compact');
    },
    compactThread: compactThreadContextNative,
    measureHistoryBytes: () => currentHistoryBytes,
  });
  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(90),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
  };
  const round = port.beginContextBudgetRound(common);
  await round.onProviderRequestPrepared(testRequestMeasurement(1_000, 300));
  await port.compactAfterModelRound({
    ...common,
    contextBudgetRound: round,
    inputTokens: 500,
  });

  assert.deepEqual(round.getToolResultContextBudget?.(), {
    kind: 'available',
    quality: 'exact',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 700,
  });

  currentHistoryBytes = 650;
  assert.deepEqual(round.getToolResultContextBudget?.(), {
    kind: 'available',
    quality: 'exact',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 450,
  });
});

void test('memory port explains every unavailable tool-result budget boundary', async (t) => {
  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(90_1),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
  };

  await t.test('request was not measured', async () => {
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 1_000,
        thresholdTokens: 900,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async () => {
        throw new Error('must not compact');
      },
      compactThread: compactThreadContextNative,
    });
    const round = port.beginContextBudgetRound(common);
    assert.deepEqual(round.getToolResultContextBudget?.(), {
      kind: 'unknown',
      modelKey: 'openai_codex_direct\0gpt-test',
      reason: 'request_measurement_unavailable',
    });
    assert.deepEqual(await round.prepareBeforeModelRound?.(), {
      kind: 'failed',
      message:
        'context preparation was requested without an actionable admission',
    });
  });

  await t.test('policy resolution failed', async () => {
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => {
        throw new Error('policy unavailable');
      },
      compactHistory: async () => {
        throw new Error('must not compact');
      },
      compactThread: compactThreadContextNative,
    });
    const round = port.beginContextBudgetRound(common);
    await round.onProviderRequestPrepared(testRequestMeasurement(100));
    assert.deepEqual(round.getToolResultContextBudget?.(), {
      kind: 'unknown',
      modelKey: 'openai_codex_direct\0gpt-test',
      reason: 'policy_unavailable',
    });
  });

  await t.test('exact usage has not calibrated the model', async () => {
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 1_000,
        thresholdTokens: 900,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async () => {
        throw new Error('must not compact');
      },
      compactThread: compactThreadContextNative,
    });
    const round = port.beginContextBudgetRound(common);
    await round.onProviderRequestPrepared(testRequestMeasurement(100));
    assert.deepEqual(round.getToolResultContextBudget?.(), {
      kind: 'unknown',
      modelKey: 'openai_codex_direct\0gpt-test',
      reason: 'usage_unavailable',
    });
  });

  await t.test('history measurement throws after exact usage', async () => {
    let measurementFails = false;
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 1_000,
        thresholdTokens: 900,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async () => {
        throw new Error('must not compact');
      },
      compactThread: compactThreadContextNative,
      measureHistoryBytes: () => {
        if (measurementFails) {
          throw new Error('history measurement unavailable');
        }
        return 100;
      },
    });
    const round = port.beginContextBudgetRound(common);
    await round.onProviderRequestPrepared(testRequestMeasurement(100));
    await port.compactAfterModelRound({
      ...common,
      contextBudgetRound: round,
      inputTokens: 50,
    });
    measurementFails = true;
    assert.deepEqual(round.getToolResultContextBudget?.(), {
      kind: 'unknown',
      modelKey: 'openai_codex_direct\0gpt-test',
      reason: 'history_measurement_failed',
    });
  });

  await t.test('derived byte budget is not a safe integer', async () => {
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 1_000,
        thresholdTokens: 900,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async () => {
        throw new Error('must not compact');
      },
      compactThread: compactThreadContextNative,
      measureHistoryBytes: () => 0,
    });
    const round = port.beginContextBudgetRound(common);
    await round.onProviderRequestPrepared(
      testRequestMeasurement(Number.MAX_SAFE_INTEGER, 0),
    );
    await port.compactAfterModelRound({
      ...common,
      contextBudgetRound: round,
      inputTokens: 1,
    });
    assert.deepEqual(round.getToolResultContextBudget?.(), {
      kind: 'unknown',
      modelKey: 'openai_codex_direct\0gpt-test',
      reason: 'invalid_measurement',
    });
  });
});

void test('memory port estimates from same-model exact usage and rebases after compaction', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const oldContext = 'older projected context '.repeat(200);
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: oldContext,
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: oldContext,
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    const retainedEntry = await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'hello',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const history: HistoryItem[] = [
      { kind: 'user', text: oldContext },
      { kind: 'assistant', phase: 'final_answer', text: oldContext },
      { kind: 'user', text: 'hello' },
    ];
    let policyCalls = 0;
    let compactCalls = 0;
    const contextUsage: ContextUsageUpdatedEventPayload[] = [];
    const providerWebSocketSessions = {
      acquireWebSocket: () => {
        throw new Error('not used');
      },
    };
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => {
        policyCalls += 1;
        return {
          providerId: 'openai_codex_direct',
          model: 'gpt-test',
          contextWindow: 100,
          thresholdTokens: 90,
          supportsParallelToolCalls: true,
        };
      },
      compactHistory: async (input, policy) => {
        compactCalls += 1;
        assert.equal(
          input.providerWebSocketSessions,
          providerWebSocketSessions,
        );
        assert.notEqual(input.history, history);
        assert.deepEqual(input.history, history.slice(0, 2));
        assert.deepEqual(
          input.deferredTools?.map((tool) => tool.name),
          ['mcp_external_lookup'],
        );
        assert.match(
          input.systemPrompt,
          /Tool results in the prefix are already the model-visible/u,
        );
        assert.equal(policy.thresholdTokens, 90);
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          providerUsageTelemetry: {
            inputTokens: 120,
            outputTokens: 15,
            cachedInputTokens: 20,
          },
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-checkpoint',
            },
          ],
        };
      },
      compactThread: compactThreadContextNative,
    });
    const common = {
      workspaceRoot,
      threadId,
      history,
      systemPrompt: 'system',
      tools: [],
      deferredTools: [
        {
          type: 'function' as const,
          name: 'mcp_external_lookup',
          description: 'Look up an external record.',
          parameters: {
            type: 'object' as const,
            properties: {},
            required: [],
            additionalProperties: false as const,
          },
          strict: false,
        },
      ],
      providerWebSocketSessions,
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    };
    const beginRound = async (requestBytes: number) => {
      const round = port.beginContextBudgetRound({
        ...common,
        onContextUsage(snapshot) {
          contextUsage.push(snapshot);
        },
      });
      await round.onProviderRequestPrepared(
        testRequestMeasurement(requestBytes),
      );
      return round;
    };

    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: await beginRound(400),
        inputTokens: 89,
      }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: await beginRound(200),
        inputTokens: 90,
      }),
      {
        kind: 'compacted',
        providerRoundAnchorEntryId: retainedEntry.entryId,
        providerUsageTelemetry: {
          inputTokens: 120,
          outputTokens: 15,
          cachedInputTokens: 20,
        },
      },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: port.beginContextBudgetRound(common),
        inputTokens: 90,
      }),
      { kind: 'not_needed', reason: 'no_material_growth' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: await beginRound(100),
        inputTokens: 40,
      }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );
    assert.equal(policyCalls, 1);
    assert.equal(compactCalls, 1);
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    const checkpoint = stored[3];
    assert.equal(checkpoint?.role, 'compaction');
    if (checkpoint?.role !== 'compaction') {
      assert.fail('expected a committed compaction checkpoint');
    }
    assert.ok(isProviderNativeCompactionEntryData(checkpoint.compactionData));
    const { historyBytesBefore, historyBytesAfter } = checkpoint.compactionData;
    assert.equal(typeof historyBytesBefore, 'number');
    assert.equal(typeof historyBytesAfter, 'number');
    assert.deepEqual(contextUsage, [
      {
        state: 'measured',
        quality: 'unknown',
        modelId: 'gpt-test',
        requestBytes: 400,
        contextWindow: 100,
        thresholdTokens: 90,
      },
      {
        state: 'measured',
        quality: 'exact',
        modelId: 'gpt-test',
        inputTokens: 89,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 400,
      },
      {
        state: 'measured',
        quality: 'estimated',
        modelId: 'gpt-test',
        inputTokens: 45,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 200,
      },
      {
        state: 'measured',
        quality: 'exact',
        modelId: 'gpt-test',
        inputTokens: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 200,
      },
      {
        state: 'compacted',
        quality: 'exact',
        modelId: 'gpt-test',
        inputTokens: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 200,
        compactionEntryId: checkpoint.entryId,
        historyBytesBefore,
        historyBytesAfter,
      },
      {
        state: 'measured',
        quality: 'estimated',
        modelId: 'gpt-test',
        inputTokens: 45,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 100,
      },
      {
        state: 'measured',
        quality: 'exact',
        modelId: 'gpt-test',
        inputTokens: 40,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 100,
      },
    ]);
    assert.equal(history[0]?.kind, 'provider_native_compaction');
    assert.deepEqual(history.slice(1), [{ kind: 'user', text: 'hello' }]);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'assistant', 'user', 'compaction'],
    );
    assert.equal(checkpoint.compactionData.tokensBefore, 90);
  });
});

void test('memory port admits fitting requests and prepares near-policy or over-window requests before dispatch', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const oldContext = 'large active context '.repeat(200);
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: oldContext,
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: oldContext,
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'current request',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const history: HistoryItem[] = [
      { kind: 'user', text: oldContext },
      { kind: 'assistant', phase: 'final_answer', text: oldContext },
      { kind: 'user', text: 'current request' },
    ];
    const contextUsage: ContextUsageUpdatedEventPayload[] = [];
    let policyCalls = 0;
    let compactCalls = 0;
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => {
        policyCalls += 1;
        return {
          providerId: 'openai_codex_direct',
          model: 'gpt-test',
          contextWindow: 100,
          thresholdTokens: 90,
          supportsParallelToolCalls: true,
        };
      },
      compactHistory: async (input) => {
        compactCalls += 1;
        assert.deepEqual(input.history, history.slice(0, 2));
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-pre-dispatch-checkpoint',
            },
          ],
        };
      },
      compactThread: compactThreadContextNative,
    });
    const common = {
      workspaceRoot,
      threadId,
      history,
      systemPrompt: 'system',
      tools: [],
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
      onContextUsage(snapshot: ContextUsageUpdatedEventPayload) {
        contextUsage.push(snapshot);
      },
    };
    const calibrationRound = port.beginContextBudgetRound(common);
    assert.deepEqual(
      await calibrationRound.onProviderRequestPrepared(
        testRequestMeasurement(100),
      ),
      { kind: 'send' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: calibrationRound,
        inputTokens: 50,
      }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );

    const fittingRound = port.beginContextBudgetRound(common);
    assert.deepEqual(
      await fittingRound.onProviderRequestPrepared(testRequestMeasurement(178)),
      { kind: 'send' },
    );
    const overWindowRound = port.beginContextBudgetRound(common);
    assert.deepEqual(
      await overWindowRound.onProviderRequestPrepared(
        testRequestMeasurement(202),
      ),
      { kind: 'prepare', reason: 'over_window' },
    );
    const nearPolicyRound = port.beginContextBudgetRound(common);
    assert.deepEqual(
      await nearPolicyRound.onProviderRequestPrepared(
        testRequestMeasurement(180),
      ),
      { kind: 'prepare', reason: 'near_policy' },
    );
    assert.deepEqual(await nearPolicyRound.prepareBeforeModelRound(), {
      kind: 'prepared',
    });
    assert.deepEqual(await nearPolicyRound.prepareBeforeModelRound(), {
      kind: 'failed',
      message:
        'context preparation was requested without an actionable admission',
    });

    assert.equal(policyCalls, 1);
    assert.equal(compactCalls, 1);
    assert.equal(history[0]?.kind, 'provider_native_compaction');
    assert.deepEqual(history.slice(1), [
      { kind: 'user', text: 'current request' },
    ]);
    assert.deepEqual(contextUsage.slice(-2), [
      {
        state: 'measured',
        quality: 'estimated',
        modelId: 'gpt-test',
        inputTokens: 101,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 202,
      },
      {
        state: 'measured',
        quality: 'estimated',
        modelId: 'gpt-test',
        inputTokens: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        requestBytes: 180,
      },
    ]);

    const unchangedRound = port.beginContextBudgetRound(common);
    assert.deepEqual(
      await unchangedRound.onProviderRequestPrepared(
        testRequestMeasurement(180),
      ),
      { kind: 'prepare', reason: 'near_policy' },
    );
    assert.deepEqual(await unchangedRound.prepareBeforeModelRound(), {
      kind: 'failed',
      message:
        'context preparation requires material history growth after the current compaction checkpoint',
    });
    assert.equal(compactCalls, 1);
  });
});

void test('memory port suppresses an ineffective compaction until the same boundary materially grows', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'old',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'current',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
      { kind: 'user', text: 'current' },
    ];
    let compactCalls = 0;
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 100,
        thresholdTokens: 90,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async () => {
        compactCalls += 1;
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'not-smaller',
            },
          ],
        };
      },
      compactThread: async (args) =>
        await compactThreadContextNative({
          ...args,
          measureHistoryBytes: () => 100,
        }),
    });
    const common = {
      workspaceRoot,
      threadId,
      history,
      systemPrompt: 'system',
      tools: [],
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
    };
    const compact = async () =>
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: port.beginContextBudgetRound(common),
        inputTokens: 90,
      });

    assert.deepEqual(await compact(), {
      kind: 'failed',
      reason: 'compaction_ineffective',
      message: 'context compaction did not produce a smaller validated history',
    });
    assert.deepEqual(await compact(), {
      kind: 'failed',
      reason: 'compaction_ineffective',
      message: 'context compaction did not produce a smaller validated history',
    });
    assert.equal(compactCalls, 1);

    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: 'materially newer tail',
      timestamp: '2026-07-17T00:00:03.000Z',
    });
    history.push({
      kind: 'assistant',
      phase: 'final_answer',
      text: 'materially newer tail',
    });
    assert.equal((await compact()).kind, 'failed');
    assert.equal(compactCalls, 2);
  });
});

void test('memory port applies the canonical Grok native policy at the approved 85 percent threshold', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const oldContext = 'older Grok context '.repeat(200);
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: oldContext,
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'assistant',
      content: oldContext,
      timestamp: '2026-07-17T00:00:01.000Z',
    });
    const retainedEntry = await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'hello Grok',
      timestamp: '2026-07-17T00:00:02.000Z',
    });
    const history: HistoryItem[] = [
      { kind: 'user', text: oldContext },
      { kind: 'assistant', phase: 'final_answer', text: oldContext },
      { kind: 'user', text: 'hello Grok' },
    ];
    let policyCalls = 0;
    let compactCalls = 0;
    const port = createAgentLoopMemoryPort({
      resolvePolicy: async (input) => {
        policyCalls += 1;
        assert.equal(input.providerRequestOptions.providerId, 'grok_oauth');
        return {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
          contextWindow: 500_000,
          thresholdTokens: 425_000,
        };
      },
      compactHistory: async (input, policy) => {
        compactCalls += 1;
        assert.deepEqual(input.history, history.slice(0, 2));
        assert.equal(policy.providerId, 'grok_oauth');
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              id: 'xai-compaction-id',
              type: 'compaction',
              encrypted_content: 'opaque-grok-checkpoint',
            },
          ],
        };
      },
      compactThread: compactThreadContextNative,
    });
    const common = {
      workspaceRoot,
      threadId,
      history,
      systemPrompt: 'system',
      tools: [],
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: {
        ...TEST_PROVIDER_REQUEST_OPTIONS,
        providerId: 'grok_oauth' as const,
        model: 'grok-4.5',
      },
    };

    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: port.beginContextBudgetRound({
          ...common,
        }),
        inputTokens: 424_999,
      }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({
        ...common,
        contextBudgetRound: port.beginContextBudgetRound({
          ...common,
        }),
        inputTokens: 425_000,
      }),
      {
        kind: 'compacted',
        providerRoundAnchorEntryId: retainedEntry.entryId,
      },
    );
    assert.equal(policyCalls, 1);
    assert.equal(compactCalls, 1);
    assert.deepEqual(history, [
      {
        kind: 'provider_native_compaction',
        providerId: 'grok_oauth',
        model: 'grok-4.5',
        providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
        output: [
          {
            id: 'xai-compaction-id',
            type: 'compaction',
            encrypted_content: 'opaque-grok-checkpoint',
          },
        ],
      },
      { kind: 'user', text: 'hello Grok' },
    ]);
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    const checkpoint = stored.at(-1);
    assert.equal(checkpoint?.role, 'compaction');
    if (checkpoint?.role === 'compaction') {
      assert.ok(isProviderNativeCompactionEntryData(checkpoint.compactionData));
      assert.equal(checkpoint.compactionData.providerId, 'grok_oauth');
      assert.equal(checkpoint.compactionData.model, 'grok-4.5');
      assert.equal(checkpoint.compactionData.thresholdTokens, 425_000);
    }
  });
});

void test('memory port reports unknown admission when policy or exact input usage is unavailable', async () => {
  let policyCalls = 0;
  const contextUsage: ContextUsageUpdatedEventPayload[] = [];
  const port = createAgentLoopMemoryPort({
    resolvePolicy: async () => {
      policyCalls += 1;
      throw new Error('must not resolve');
    },
    compactHistory: async () => {
      throw new Error('must not compact');
    },
    compactThread: compactThreadContextNative,
  });

  const common = {
    workspaceRoot: '/unused',
    threadId: testThreadId(93),
    history: [] as HistoryItem[],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
  };
  const contextBudgetRound = port.beginContextBudgetRound({
    ...common,
    onContextUsage(snapshot) {
      contextUsage.push(snapshot);
    },
  });
  await contextBudgetRound.onProviderRequestPrepared(
    testRequestMeasurement(900),
  );
  const result = await port.compactAfterModelRound({
    ...common,
    contextBudgetRound,
  });

  assert.deepEqual(result, {
    kind: 'not_needed',
    reason: 'usage_unavailable',
  });
  assert.equal(policyCalls, 1);
  assert.deepEqual(contextUsage, [
    {
      state: 'measured',
      quality: 'unknown',
      modelId: 'gpt-test',
      requestBytes: 900,
    },
  ]);
});
