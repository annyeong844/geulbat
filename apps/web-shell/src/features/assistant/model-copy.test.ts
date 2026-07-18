import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSubagentModelMeta, formatRunModelLabel } from './model-copy.js';

void test('formatSubagentModelMeta renders model label with reasoning effort', () => {
  assert.equal(
    formatSubagentModelMeta({
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    }),
    'GPT-5.6 Luna · 사고 높음',
  );
  assert.equal(formatSubagentModelMeta({ modelId: 'grok-4.5' }), 'Grok 4.5');
  assert.equal(formatSubagentModelMeta({}), null);
});

void test('formatRunModelLabel falls back to the raw id for unknown models', () => {
  assert.equal(formatRunModelLabel('mystery-model'), 'mystery-model');
});
