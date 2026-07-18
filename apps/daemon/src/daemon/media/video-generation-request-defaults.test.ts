import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadId } from '@geulbat/protocol/ids';
import type { GenerateVideoArtifactInput } from './contract.js';
import { applyVideoGenerationRequestDefaults } from './video-generation-request-defaults.js';

const BASE_INPUT: GenerateVideoArtifactInput = {
  request: { prompt: 'a cat' },
  stateRoot: '/root',
  workingDirectory: 'workspace',
  threadId: '11111111-1111-4111-8111-111111111111' as ThreadId,
  runId: 'run-1',
};

void test('video request defaults fill model and duration only when the turn did not specify them', () => {
  const applied = applyVideoGenerationRequestDefaults(BASE_INPUT, {
    model: 'grok-imagine-video-1.5',
    durationSeconds: 10,
  });
  assert.equal(applied.request.model, 'grok-imagine-video-1.5');
  assert.equal(applied.request.durationSeconds, 10);

  // 현재 턴 명시(D2)가 있으면 기본값이 덮지 않는다
  const explicit = applyVideoGenerationRequestDefaults(
    {
      ...BASE_INPUT,
      request: { prompt: 'a cat', durationSeconds: 3, model: 'other-model' },
    },
    { model: 'grok-imagine-video-1.5', durationSeconds: 10 },
  );
  assert.equal(explicit.request.model, 'other-model');
  assert.equal(explicit.request.durationSeconds, 3);

  // duration 기본값이 없으면 채우지 않는다(내장 사다리로 흐름)
  const modelOnly = applyVideoGenerationRequestDefaults(BASE_INPUT, {
    model: 'grok-imagine-video-1.5',
  });
  assert.equal(modelOnly.request.durationSeconds, undefined);
});
