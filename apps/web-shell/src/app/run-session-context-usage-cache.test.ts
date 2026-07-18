import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readStoredContextUsageByThread,
  storeContextUsageByThread,
} from './run-session-context-usage-cache.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const CONTEXT_USAGE = {
  state: 'measured',
  modelId: 'gpt-5.6-sol',
  inputTokens: 122_400,
  contextWindow: 272_000,
  thresholdTokens: 244_800,
} as const;

void test('context usage cache round-trips the last exact snapshot by thread', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  storeContextUsageByThread({ [THREAD_ID]: CONTEXT_USAGE }, storage);

  assert.deepEqual(readStoredContextUsageByThread(storage), {
    [THREAD_ID]: CONTEXT_USAGE,
  });
});

void test('context usage cache restores valid entries without trusting malformed local data', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  storeContextUsageByThread({}, storage);
  const cacheKey = values.keys().next().value;
  assert.equal(typeof cacheKey, 'string');
  if (typeof cacheKey !== 'string') {
    return;
  }
  values.set(
    cacheKey,
    JSON.stringify({
      version: 1,
      contextUsageByThread: {
        [THREAD_ID]: CONTEXT_USAGE,
        broken: {
          ...CONTEXT_USAGE,
          thresholdTokens: CONTEXT_USAGE.contextWindow + 1,
        },
      },
    }),
  );

  assert.deepEqual(readStoredContextUsageByThread(storage), {
    [THREAD_ID]: CONTEXT_USAGE,
  });

  values.set(cacheKey, '{not json');
  assert.deepEqual(readStoredContextUsageByThread(storage), {});
});
