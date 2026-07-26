import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_MODEL_TAGLINES,
  formatSubagentModelMeta,
  formatRunModelLabel,
} from './model-copy.js';

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

void test('Qwen preview model copy is available to model pickers', () => {
  assert.equal(
    formatRunModelLabel('qwen3.8-max-preview'),
    'Qwen3.8 Max Preview',
  );
  assert.equal(
    RUN_MODEL_TAGLINES['qwen3.8-max-preview'],
    '긴 맥락과 깊은 사고가 필요할 때',
  );
});
