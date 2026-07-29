import test from 'node:test';
import assert from 'node:assert/strict';

import { isImageGenerationError } from '../contract.js';
import { generateImageViaGrok } from './grok-image-provider.js';

const PNG_BASE64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('grok-image-body'),
]).toString('base64');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

void test('generateImageViaGrok posts bearer request and returns validated candidate', async () => {
  const seenRequests: { url: string; init: RequestInit }[] = [];
  const candidate = await generateImageViaGrok({
    request: { prompt: '붉은 판다 수채화' },
    auth: { accessToken: 'grok-access-token' },
    now: () => '2026-07-05T00:00:00.000Z',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seenRequests.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, {
        data: [
          { b64_json: PNG_BASE64, revised_prompt: 'watercolor red panda' },
        ],
      });
    }) as typeof fetch,
  });

  assert.equal(seenRequests.length, 1);
  const request = seenRequests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://api.x.ai/v1/images/generations');
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer grok-access-token');
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.prompt, '붉은 판다 수채화');
  assert.equal(body.n, 1);
  assert.equal(body.response_format, 'b64_json');

  assert.equal(candidate.asset.mimeType, 'image/png');
  assert.equal(candidate.provenance.providerId, 'grok_oauth');
  assert.equal(candidate.provenance.revisedPrompt, 'watercolor red panda');
  assert.equal(candidate.provenance.generatedAt, '2026-07-05T00:00:00.000Z');
});

void test('generateImageViaGrok delegates the billable POST to its durable request owner', async () => {
  let fetchCalls = 0;
  const createRequests: {
    requestUrl: string;
    headers: Headers;
    serializedPayload: string;
  }[] = [];
  const candidate = await generateImageViaGrok({
    request: { prompt: 'durable red panda' },
    auth: { accessToken: 'grok-access-token' },
    now: () => '2026-07-05T00:00:00.000Z',
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error('direct fetch must not run');
    }) as typeof fetch,
    createRequestImpl: async (request) => {
      createRequests.push(request);
      return {
        data: [{ b64_json: PNG_BASE64 }],
      };
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(createRequests.length, 1);
  const request = createRequests[0];
  assert.ok(request);
  assert.equal(request.requestUrl, 'https://api.x.ai/v1/images/generations');
  assert.equal(request.headers.get('accept'), 'application/json');
  assert.equal(
    request.headers.get('authorization'),
    'Bearer grok-access-token',
  );
  assert.deepEqual(JSON.parse(request.serializedPayload), {
    model: 'grok-imagine-image-quality',
    prompt: 'durable red panda',
    n: 1,
    response_format: 'b64_json',
  });
  assert.equal(candidate.provenance.providerId, 'grok_oauth');
});

void test('generateImageViaGrok preserves auth classification from its durable request owner', async () => {
  try {
    await generateImageViaGrok({
      request: { prompt: 'p' },
      auth: { accessToken: 'expired-token' },
      createRequestImpl: async () => {
        throw Object.assign(new Error('secret-upstream-detail'), {
          status: 401,
        });
      },
    });
    assert.fail('expected provider_auth failure');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'provider_auth');
    assert.equal(error.reasonCode, 'provider_auth_rejected');
    assert.ok(!error.message.includes('secret-upstream-detail'));
  }
});

void test('generateImageViaGrok classifies 401 as provider_auth without leaking body', async () => {
  try {
    await generateImageViaGrok({
      request: { prompt: 'p' },
      auth: { accessToken: 'expired-token' },
      fetchImpl: (async () =>
        jsonResponse(401, {
          error: 'secret-upstream-detail sk-super-secret',
        })) as typeof fetch,
    });
    assert.fail('expected provider_auth failure');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'provider_auth');
    assert.ok(!error.message.includes('sk-super-secret'));
  }
});

void test('generateImageViaGrok classifies empty data as provider_api failure', async () => {
  try {
    await generateImageViaGrok({
      request: { prompt: 'p' },
      auth: { accessToken: 't' },
      fetchImpl: (async () => jsonResponse(200, { data: [] })) as typeof fetch,
    });
    assert.fail('expected provider_api failure');
  } catch (error: unknown) {
    assert.ok(isImageGenerationError(error));
    assert.equal(error.surface, 'provider_api');
    assert.equal(error.reasonCode, 'empty_image_result');
  }
});
