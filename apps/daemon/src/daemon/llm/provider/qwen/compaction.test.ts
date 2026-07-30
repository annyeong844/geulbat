import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveQwenContextCapacityPolicy,
  streamQwenChatCompletions,
  summarizeQwenHistory,
  type QwenChatCompletionsInput,
  type QwenTokenPlanConfig,
} from './index.js';

const CONFIG: QwenTokenPlanConfig = {
  model: 'qwen3.8-max-preview',
  baseUrl:
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  chatCompletionsUrl:
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
  apiKey: 'x'.repeat(32),
  credentialIdentity: 'test-credential',
};

void test('Qwen summary compaction uses the selected model with its required thinking mode and no tools', async () => {
  let observed: QwenChatCompletionsInput | undefined;
  const result = await summarizeQwenHistory(
    {
      historyPrefix: [
        { kind: 'user', text: 'Inspect the repository.' },
        {
          kind: 'assistant',
          phase: 'final_answer',
          text: 'I found the owner.',
        },
      ],
      model: 'qwen3.8-max-preview',
      providerSessionId: 'thread-summary',
    },
    resolveQwenContextCapacityPolicy('qwen3.8-max-preview'),
    {
      loadConfig: async () => CONFIG,
      streamChatCompletions: async (input) => {
        observed = input;
        return {
          itemsToAppend: [
            {
              kind: 'backend_item',
              data: {
                type: 'message',
                id: 'summary-1',
                role: 'assistant',
                status: 'completed',
                phase: 'final_answer',
                content: [
                  {
                    type: 'output_text',
                    text: 'Repository review is in progress.\nOwner: compaction-loop.ts',
                    annotations: [],
                  },
                ],
              },
            },
          ],
          functionCalls: [],
          assistantText:
            'Repository review is in progress.\nOwner: compaction-loop.ts',
          finalText:
            'Repository review is in progress.\nOwner: compaction-loop.ts',
          providerUsageTelemetry: {
            inputTokens: 800_000,
            outputTokens: 12,
          },
        };
      },
    },
  );

  assert.equal(observed?.config.model, 'qwen3.8-max-preview');
  assert.equal(observed?.enableThinking, true);
  assert.equal(observed?.maxTokens, 20_000);
  assert.equal(observed?.tools, undefined);
  assert.equal(observed?.providerSessionId, 'qwen-summary:thread-summary');
  assert.equal(observed?.requestAttempt, 0);
  assert.match(observed?.instructions ?? '', /continuation summary/u);
  assert.equal(observed?.history.at(-1)?.kind, 'user');
  assert.deepEqual(result, {
    summary: 'Repository review is in progress.\nOwner: compaction-loop.ts',
    shortSummary: 'Repository review is in progress.',
    summaryTokens: 12,
    providerUsageTelemetry: {
      inputTokens: 800_000,
      outputTokens: 12,
    },
  });
});

void test('Qwen summary compaction fails closed without exact output usage', async () => {
  await assert.rejects(
    summarizeQwenHistory(
      {
        historyPrefix: [{ kind: 'user', text: 'Older context.' }],
        model: 'qwen3.8-max-preview',
        providerSessionId: 'thread-summary',
      },
      resolveQwenContextCapacityPolicy('qwen3.8-max-preview'),
      {
        loadConfig: async () => CONFIG,
        streamChatCompletions: async () => ({
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'Summary.',
          finalText: 'Summary.',
        }),
      },
    ),
    /exact output token usage/u,
  );
});

void test('Qwen summary compaction fails closed before direct fetch when its durable owner is unavailable', async () => {
  let directFetchCalls = 0;
  await assert.rejects(
    summarizeQwenHistory(
      {
        historyPrefix: [{ kind: 'user', text: 'Older context.' }],
        model: 'qwen3.8-max-preview',
        providerSessionId: 'thread-summary',
        providerRequestSessions: {},
      },
      resolveQwenContextCapacityPolicy('qwen3.8-max-preview'),
      {
        loadConfig: async () => CONFIG,
        streamChatCompletions: async (input) =>
          await streamQwenChatCompletions(input, {
            fetchImpl: async () => {
              directFetchCalls += 1;
              throw new Error('direct fetch must not run');
            },
          }),
      },
    ),
    /durable provider request transport is unavailable/u,
  );
  assert.equal(directFetchCalls, 0);
});
