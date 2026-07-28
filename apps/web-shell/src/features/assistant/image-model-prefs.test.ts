import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getImageGenerationModelPref,
  setImageGenerationModelPref,
  subscribeImageGenerationModelPref,
} from './image-model-prefs.js';

void test('image model pref round-trips, notifies subscribers, and allows clearing', () => {
  const seen: Array<string | null> = [];
  const unsubscribe = subscribeImageGenerationModelPref(() => {
    seen.push(getImageGenerationModelPref());
  });

  setImageGenerationModelPref('grok-imagine-image-quality');
  assert.equal(getImageGenerationModelPref(), 'grok-imagine-image-quality');

  // 무선택 상태 허용 — 선택 해제
  setImageGenerationModelPref(null);
  assert.equal(getImageGenerationModelPref(), null);

  assert.deepEqual(seen, ['grok-imagine-image-quality', null]);
  unsubscribe();
});
