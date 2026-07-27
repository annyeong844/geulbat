import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isProviderNativeCompactionEntryData } from '@geulbat/protocol/threads';
import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';

import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from '../../llm/provider/provider-options.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import type { ResponsesRequestMeasurement } from '../../llm/provider/transport/responses-websocket.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentLoopMemoryPort } from './compaction-loop.js';
import { prepareProviderTransitionCompaction } from './provider-transition-compaction.js';
import {
  compactThreadContextForProviderTransition,
  compactThreadContextNative,
} from './compaction-run.js';

const TEST_PROVIDER_REQUEST_OPTIONS: ProviderRequestOptions = {
  ...resolveProviderRequestOptions({}),
  model: 'gpt-test',
};
const TEST_REPLAY_SCOPE_ID = `sha256:${'c'.repeat(
  64,
)}` as ProviderReplayScopeId;

function testRequestMeasurement(
  serializedBytes: number,
  historyBytes = serializedBytes,
): ResponsesRequestMeasurement {
  return {
    serializedBytes,
    dominantPressureSource: 'history',
    serializedBytesBySource: {
      history: historyBytes,
      instructions: 0,
      toolDefinitions: 0,
      envelope: 0,
    },
  };
}

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

async function withThread(
  run: (args: { workspaceRoot: string; threadId: string }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-compaction-loop-'),
  );
  try {
    await run({ workspaceRoot, threadId: testThreadId(92) });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
