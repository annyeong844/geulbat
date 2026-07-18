import test from 'node:test';
import assert from 'node:assert/strict';

import { isImageGenerationError } from '../contract.js';
import {
  buildCodexImageRequestPayload,
  generateImageViaCodexResponses,
} from './codex-image-provider.js';
import type { streamResponsesOverWebSocket } from '../../llm/provider/transport/responses-websocket.js';
import { CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY } from '../../llm/provider/client.js';

const PNG_BASE64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('codex-image-body'),
]).toString('base64');

const fakeSessionStore = {
  acquireWebSocket: () => {
    throw new Error('not used in this test');
  },
};

function buildStreamResult(
  itemsToAppend: { kind: 'backend_item'; data: unknown }[],
) {
  return {
    itemsToAppend,
    functionCalls: [],
    assistantText: '',
    finalText: '',
  };
}

void test('buildCodexImageRequestPayload shapes a hosted image_generation response.create', () => {
  const payload = buildCodexImageRequestPayload({
    request: { prompt: '한강 야경', size: '1536x1024', quality: 'high' },
    model: 'gpt-5.4-mini',
    providerSessionId: 'image-generation:thread-1',
  });

  assert.equal(payload.type, 'response.create');
  assert.equal(payload.model, 'gpt-5.4-mini');
  assert.equal(payload.store, false);
  assert.equal(payload.tool_choice, 'required');
  const tools = payload.tools as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], {
    type: 'image_generation',
    model: 'gpt-image-2',
    moderation: 'low',
    size: '1536x1024',
    quality: 'high',
  });
  const input = payload.input as { role: string; content: string }[];
  assert.equal(input[0]?.role, 'developer');
  assert.ok(input[1]?.content.includes('한강 야경'));
});

void test('generateImageViaCodexResponses extracts image_generation_call from backend items', async () => {
  const candidate = await generateImageViaCodexResponses({
    request: { prompt: '고양이' },
    auth: { accessToken: 'codex-access-token', accountId: 'acct-1' },
    providerSessionId: 'image-generation:thread-1',
    providerWebSocketSessions: fakeSessionStore,
    now: () => '2026-07-05T00:00:00.000Z',
    streamResponses: (async (input) => {
      const headers = input.headers;
      assert.equal(headers.get('authorization'), 'Bearer codex-access-token');
      assert.equal(headers.get('chatgpt-account-id'), 'acct-1');
      assert.ok(input.payload);
      assert.deepEqual(
        input.webSocketReusePolicy,
        CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
      );
      return buildStreamResult([
        { kind: 'backend_item', data: { type: 'reasoning', summary: [] } },
        {
          kind: 'backend_item',
          data: {
            type: 'image_generation_call',
            result: PNG_BASE64,
            revised_prompt: 'a cat, refined',
          },
        },
      ]);
    }) as typeof streamResponsesOverWebSocket,
  });

  assert.equal(candidate.asset.mimeType, 'image/png');
  assert.equal(candidate.provenance.providerId, 'openai_codex_direct');
  assert.equal(candidate.provenance.revisedPrompt, 'a cat, refined');
});

void test('generateImageViaCodexResponses fails as provider_api when no image item arrives', async () => {
  try {
    await generateImageViaCodexResponses({
      request: { prompt: 'p' },
      auth: { accessToken: 't', accountId: 'a' },
      providerSessionId: 's',
      providerWebSocketSessions: fakeSessionStore,
      streamResponses: (async () =>
        buildStreamResult([])) as typeof streamResponsesOverWebSocket,
    });
    assert.fail('expected provider_api failure');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'provider_api');
    assert.equal(error.reasonCode, 'empty_image_result');
  }
});
