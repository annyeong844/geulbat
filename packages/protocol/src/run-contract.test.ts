import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_GENERATION_MODEL_CATALOG,
  RUN_MODEL_CATALOG,
  VIDEO_GENERATION_MODEL_CATALOG,
  isImageGenerationModelId,
  isRunPromptInputRefResponse,
  isRunRequest,
  isRunStartRequest,
  isRunSubagentModelRouting,
  isVideoGenerationModelId,
  isVideoGenerationSettings,
  resolveImageGenerationModelDescriptor,
  resolveVideoGenerationModelDescriptor,
} from './run-contract.js';

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('isRunRequest accepts an optional working directory and rejects project ownership', () => {
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      workingDirectory: 'Users/sample/Documents',
      threadId: VALID_THREAD_ID,
    }),
    true,
  );

  assert.equal(
    isRunRequest({
      prompt: 'hello',
      projectId: 'workspace',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('promptOrigin accepts only the artifact_frame marker', () => {
  assert.equal(
    isRunRequest({ prompt: 'hello', promptOrigin: 'artifact_frame' }),
    true,
  );
  assert.equal(
    isRunRequest({ prompt: 'hello', promptOrigin: 'composer' }),
    false,
  );
});

void test('image generation model field accepts catalog ids and rejects unknown ids', () => {
  // 카탈로그의 모든 id가 가드를 통과하고 프로바이더를 함축한다
  for (const model of IMAGE_GENERATION_MODEL_CATALOG) {
    assert.equal(isImageGenerationModelId(model.id), true);
    assert.equal(
      resolveImageGenerationModelDescriptor(model.id).providerId,
      model.providerId,
    );
    assert.equal(
      isRunRequest({
        prompt: 'hello',
        imageGenerationModel: model.id,
      }),
      true,
    );
  }

  // 알 수 없는 id는 fail-closed — 요청 전체가 거부된다
  assert.equal(isImageGenerationModelId('grok-2-image'), false);
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      imageGenerationModel: 'grok-2-image',
    }),
    false,
  );
  assert.equal(isRunRequest({ prompt: 'hello' }), true);
});

void test('video generation model field accepts catalog ids and rejects unknown or image ids', () => {
  for (const model of VIDEO_GENERATION_MODEL_CATALOG) {
    assert.equal(isVideoGenerationModelId(model.id), true);
    assert.equal(
      resolveVideoGenerationModelDescriptor(model.id).providerId,
      model.providerId,
    );
    assert.equal(
      isRunRequest({ prompt: 'hello', videoGenerationModel: model.id }),
      true,
    );
  }

  // 교차 오염 금지 — 이미지 모델 id는 동영상 필드에서 거부되고, 그 역도
  // 마찬가지다(비디오 모델이 이미지 가드를 통과하면 안 된다)
  assert.equal(isVideoGenerationModelId('grok-imagine-image-quality'), false);
  assert.equal(isImageGenerationModelId('grok-imagine-video-1.5'), false);
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      videoGenerationModel: 'grok-imagine-image-quality',
    }),
    false,
  );
  // 구모델은 카탈로그 제외(v1 단일 모델 — 투명 캔버스 브리지)
  assert.equal(isVideoGenerationModelId('grok-imagine-video'), false);
});

void test('video generation settings guard enforces the provider duration range', () => {
  assert.equal(isVideoGenerationSettings({}), true);
  assert.equal(isVideoGenerationSettings({ durationSeconds: 5 }), true);
  assert.equal(isVideoGenerationSettings({ durationSeconds: 15 }), true);
  // 실측 가드(S0): 1~15 정수 밖은 거부
  assert.equal(isVideoGenerationSettings({ durationSeconds: 0 }), false);
  assert.equal(isVideoGenerationSettings({ durationSeconds: 16 }), false);
  assert.equal(isVideoGenerationSettings({ durationSeconds: 2.5 }), false);
  // 상세 옵션은 실측 폐쇄 집합만 허용(S3 무과금 프로브)
  assert.equal(
    isVideoGenerationSettings({
      durationSeconds: 5,
      aspectRatio: '16:9',
      resolution: '720p',
    }),
    true,
  );
  assert.equal(isVideoGenerationSettings({ aspectRatio: '21:9' }), false);
  assert.equal(isVideoGenerationSettings({ resolution: '4k' }), false);
  // 알 수 없는 설정 키는 거부(fail-closed)
  assert.equal(
    isVideoGenerationSettings({ durationSeconds: 5, fps: 60 }),
    false,
  );
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      videoGenerationSettings: { durationSeconds: 5 },
    }),
    true,
  );
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      videoGenerationSettings: { durationSeconds: 99 },
    }),
    false,
  );
});

void test('isRunRequest accepts the regenerate flag only as a boolean', () => {
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      threadId: VALID_THREAD_ID,
      regenerate: true,
    }),
    true,
  );

  assert.equal(
    isRunRequest({
      prompt: 'hello',
      threadId: VALID_THREAD_ID,
      regenerate: 'yes',
    }),
    false,
  );
});

void test('run requests accept only the canonical public tool-name field', () => {
  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      allowedPublicToolNames: ['read_file'],
    }),
    true,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      allowedToolsHint: ['read_file'],
    }),
    false,
  );
});

void test('subagent model routing accepts auto or one fixed catalog choice', () => {
  assert.equal(isRunSubagentModelRouting({ mode: 'auto' }), true);
  assert.equal(
    isRunSubagentModelRouting({
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    }),
    true,
  );
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      subagentModelRouting: {
        mode: 'fixed',
        choice: { modelId: 'grok-4.5', reasoningEffort: 'high' },
      },
    }),
    true,
  );
});

void test('subagent model routing rejects allowlists and malformed fixed choices', () => {
  assert.equal(
    isRunSubagentModelRouting({
      mode: 'allowed',
      modelIds: ['gpt-5.6-sol', 'grok-4.5'],
    }),
    false,
  );
  assert.equal(
    isRunSubagentModelRouting({
      mode: 'fixed',
      choice: { modelId: 'not-a-model' },
    }),
    false,
  );
  assert.equal(
    isRunSubagentModelRouting({
      mode: 'fixed',
      choice: { modelId: 'grok-4.5', reasoningEffort: 'xhigh' },
    }),
    false,
  );
});

void test('isRunStartRequest accepts exactly one prompt input source', () => {
  assert.equal(
    isRunStartRequest({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      threadId: VALID_THREAD_ID,
    }),
    true,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('isRunStartRequest rejects retired browserContextShare requests loudly', () => {
  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      threadId: VALID_THREAD_ID,
      browserContextShare: { mode: 'required' },
    }),
    false,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      threadId: VALID_THREAD_ID,
      browserContextShare: { mode: 'optional' },
    }),
    false,
  );
});

void test('run model catalog owns current model-to-provider projection', () => {
  assert.deepEqual(
    RUN_MODEL_CATALOG.map(({ id, providerId }) => ({ id, providerId })),
    [
      { id: 'gpt-5.6-sol', providerId: 'openai_codex_direct' },
      { id: 'gpt-5.6-terra', providerId: 'openai_codex_direct' },
      { id: 'gpt-5.6-luna', providerId: 'openai_codex_direct' },
      { id: 'grok-4.5', providerId: 'grok_oauth' },
    ],
  );
});

void test('isRunStartRequest accepts known run model ids only', () => {
  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      modelId: 'grok-4.5',
    }),
    true,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      modelId: 'not-a-model',
    }),
    false,
  );

  assert.equal(
    isRunStartRequest({
      prompt: 'hello',
      providerId: 'grok_oauth',
    }),
    false,
  );
});

void test('isRunStartRequest rejects non-string working directories', () => {
  assert.equal(
    isRunStartRequest({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      workingDirectory: 42,
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});

void test('isRunPromptInputRefResponse validates upload responses', () => {
  assert.equal(
    isRunPromptInputRefResponse({
      ok: true,
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      byteLength: 12,
    }),
    true,
  );

  assert.equal(
    isRunPromptInputRefResponse({
      ok: true,
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    false,
  );
});
