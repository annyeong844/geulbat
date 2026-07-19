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
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import {
  createAgentLoopMemoryPort,
  prepareProviderTransitionCompaction,
} from './compaction-loop.js';
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

void test('memory port uses exact response input usage and caches model policy across rounds', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'hello',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    const history: HistoryItem[] = [{ kind: 'user', text: 'hello' }];
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
        assert.equal(input.history, history);
        assert.equal(policy.thresholdTokens, 90);
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
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
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
      onContextUsage: (snapshot: ContextUsageUpdatedEventPayload) => {
        contextUsage.push(snapshot);
      },
    };

    assert.deepEqual(
      await port.compactAfterModelRound({ ...common, inputTokens: 89 }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({ ...common, inputTokens: 90 }),
      { kind: 'compacted' },
    );
    assert.equal(policyCalls, 1);
    assert.equal(compactCalls, 1);
    assert.deepEqual(contextUsage, [
      {
        state: 'measured',
        modelId: 'gpt-test',
        inputTokens: 89,
        contextWindow: 100,
        thresholdTokens: 90,
      },
      {
        state: 'measured',
        modelId: 'gpt-test',
        inputTokens: 90,
        contextWindow: 100,
        thresholdTokens: 90,
      },
      {
        state: 'compacted',
        modelId: 'gpt-test',
        inputTokens: 90,
        contextWindow: 100,
        thresholdTokens: 90,
      },
    ]);
    assert.equal(history[0]?.kind, 'provider_native_compaction');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'compaction'],
    );
    assert.equal(stored[1]?.role, 'compaction');
    if (stored[1]?.role === 'compaction') {
      assert.ok(isProviderNativeCompactionEntryData(stored[1].compactionData));
      assert.equal(stored[1].compactionData.tokensBefore, 90);
    }
  });
});

void test('memory port applies the canonical Grok native policy at the approved 85 percent threshold', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'hello Grok',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
    const history: HistoryItem[] = [{ kind: 'user', text: 'hello Grok' }];
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
        assert.equal(input.history, history);
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
        inputTokens: 424_999,
      }),
      { kind: 'not_needed', reason: 'under_threshold' },
    );
    assert.deepEqual(
      await port.compactAfterModelRound({ ...common, inputTokens: 425_000 }),
      { kind: 'compacted' },
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

void test('memory port does not guess a trigger when exact input usage is unavailable', async () => {
  let policyCalls = 0;
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

  const result = await port.compactAfterModelRound({
    workspaceRoot: '/unused',
    threadId: testThreadId(93),
    history: [],
    systemPrompt: 'system',
    tools: [],
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: TEST_PROVIDER_REQUEST_OPTIONS,
  });

  assert.deepEqual(result, {
    kind: 'not_needed',
    reason: 'usage_unavailable',
  });
  assert.equal(policyCalls, 0);
});

void test('provider transition uses the source provider and commits only its portable summary', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'user',
      content: 'continue this work',
      timestamp: '2026-07-17T00:00:00.000Z',
    });
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
        async loadHistory(_workspaceRoot, _threadId, prompt, providerTarget) {
          assert.match(prompt, /openai_codex_direct\/gpt-5\.6-sol/u);
          assert.deepEqual(providerTarget, {
            providerId: 'grok_oauth',
            model: 'grok-4.5',
            replayScopeId: TEST_REPLAY_SCOPE_ID,
          });
          return [{ kind: 'user', text: 'continue this work' }];
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
        coveredThroughEntryId: stored[0]?.entryId,
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
