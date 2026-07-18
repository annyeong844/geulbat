import assert from 'node:assert/strict';
import test from 'node:test';

import { assertThreadId } from '@geulbat/protocol/ids';
import type {
  GenerateImageArtifactInput,
  GenerateImageArtifactResult,
  ImageGenerationRuntime,
} from './contract.js';
import {
  applyImageGenerationRequestDefaults,
  withImageGenerationRequestDefaults,
} from './image-generation-request-defaults.js';

const THREAD_ID = assertThreadId('11111111-1111-4111-8111-111111111111');

function makeInput(
  overrides: Partial<GenerateImageArtifactInput> = {},
): GenerateImageArtifactInput {
  return {
    request: { prompt: '고양이' },
    stateRoot: '/tmp/home',
    workingDirectory: 'stories',
    threadId: THREAD_ID,
    runId: 'run-1',
    ...overrides,
  };
}

const GROK_QUALITY_DEFAULTS = {
  providerId: 'grok_oauth',
  model: 'grok-imagine-image-quality',
} as const;

void test('request defaults fill provider and model when the tool omitted both', () => {
  const applied = applyImageGenerationRequestDefaults(
    makeInput(),
    GROK_QUALITY_DEFAULTS,
  );
  assert.equal(applied.providerId, 'grok_oauth');
  assert.equal(applied.request.model, 'grok-imagine-image-quality');
});

void test('tool args provider wins and a different provider does not inherit the default model', () => {
  // 현재 사용자 턴 명시(툴 args)가 저장 선택보다 우선한다(§4.1)
  const applied = applyImageGenerationRequestDefaults(
    makeInput({ providerId: 'openai_codex_direct' }),
    GROK_QUALITY_DEFAULTS,
  );
  assert.equal(applied.providerId, 'openai_codex_direct');
  // grok용 모델 기본값이 openai 경로로 새면 안 된다 — env/내장으로 흐른다
  assert.equal(applied.request.model, undefined);
});

void test('same-provider tool args still inherit the default model unless preset', () => {
  const samProvider = applyImageGenerationRequestDefaults(
    makeInput({ providerId: 'grok_oauth' }),
    GROK_QUALITY_DEFAULTS,
  );
  assert.equal(samProvider.request.model, 'grok-imagine-image-quality');

  const presetModel = applyImageGenerationRequestDefaults(
    makeInput({ request: { prompt: '고양이', model: 'grok-imagine-image' } }),
    GROK_QUALITY_DEFAULTS,
  );
  assert.equal(presetModel.request.model, 'grok-imagine-image');
});

void test('wrapped runtimes stay isolated per run and never mutate the base runtime', async () => {
  const seen: Array<{ providerId?: string; model?: string }> = [];
  const base: ImageGenerationRuntime = {
    async generateImageArtifact(input) {
      seen.push({
        ...(input.providerId !== undefined
          ? { providerId: input.providerId }
          : {}),
        ...(input.request.model !== undefined
          ? { model: input.request.model }
          : {}),
      });
      return {} as GenerateImageArtifactResult;
    },
    withRequestDefaults() {
      throw new Error('wrapper delegates to the captured base, not this');
    },
  };

  // Run A=그록 퀄리티, Run B=이미지 2 — 동시 실행에도 요청 스코프가 섞이지
  // 않는다(§4.3 요청 스코프 격리)
  const runA = withImageGenerationRequestDefaults(base, GROK_QUALITY_DEFAULTS);
  const runB = withImageGenerationRequestDefaults(base, {
    providerId: 'openai_codex_direct',
    model: 'gpt-image-2',
  });
  const input = makeInput();
  await Promise.all([
    runA.generateImageArtifact(input),
    runB.generateImageArtifact(input),
    runA.generateImageArtifact(input),
  ]);

  assert.deepEqual(seen, [
    { providerId: 'grok_oauth', model: 'grok-imagine-image-quality' },
    { providerId: 'openai_codex_direct', model: 'gpt-image-2' },
    { providerId: 'grok_oauth', model: 'grok-imagine-image-quality' },
  ]);
  // 원본 입력은 불변 — 다음 run에 상태가 새지 않는다
  assert.equal(input.providerId, undefined);
  assert.equal(input.request.model, undefined);
});
