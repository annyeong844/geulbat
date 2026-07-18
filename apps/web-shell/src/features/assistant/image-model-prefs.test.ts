import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getImageGenerationModelPref,
  setImageGenerationModelPref,
  subscribeImageGenerationModelPref,
  VERIFIED_IMAGE_GENERATION_MODEL_IDS,
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

void test('catalog models are all verified after S3 pass', () => {
  // S3 게이트 해제(2026-07-13) — codex 전송 경로 라이브 E2E 통과로
  // gpt-image-2도 검증 목록에 포함된다
  assert.equal(
    VERIFIED_IMAGE_GENERATION_MODEL_IDS.has('grok-imagine-image-quality'),
    true,
  );
  assert.equal(VERIFIED_IMAGE_GENERATION_MODEL_IDS.has('gpt-image-2'), true);
});
