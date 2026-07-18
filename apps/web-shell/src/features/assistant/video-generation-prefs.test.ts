import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getVideoGenerationPref,
  setVideoGenerationPref,
  subscribeVideoGenerationPref,
  VERIFIED_VIDEO_GENERATION_MODEL_IDS,
} from './video-generation-prefs.js';

void test('video generation pref round-trips model+duration and notifies subscribers', () => {
  setVideoGenerationPref(null);
  let notified = 0;
  const unsubscribe = subscribeVideoGenerationPref(() => {
    notified += 1;
  });

  setVideoGenerationPref({
    model: 'grok-imagine-video-1.5',
    durationSeconds: 10,
    aspectRatio: '9:16',
    resolution: '720p',
  });
  assert.deepEqual(getVideoGenerationPref(), {
    model: 'grok-imagine-video-1.5',
    durationSeconds: 10,
    aspectRatio: '9:16',
    resolution: '720p',
  });

  setVideoGenerationPref(null);
  assert.equal(getVideoGenerationPref(), null);
  assert.equal(notified, 2);
  unsubscribe();
});

void test('grok-imagine-video-1.5 is selectable in the settings popup', () => {
  // 사용자 결정(2026-07-13)으로 팝업 조작을 즉시 오픈 — 데몬 런타임은
  // 단위테스트+S0 실측으로 검증됨
  assert.equal(
    VERIFIED_VIDEO_GENERATION_MODEL_IDS.has('grok-imagine-video-1.5'),
    true,
  );
});
