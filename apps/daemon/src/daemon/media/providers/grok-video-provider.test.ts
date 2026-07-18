import assert from 'node:assert/strict';
import test from 'node:test';

import { ImageGenerationError } from '../contract.js';
import { generateVideoViaGrok } from './grok-video-provider.js';

// 실 API 형태는 S0 실측(2026-07-13): POST → {request_id}, GET →
// {status: pending|done|failed|expired, video: {url, duration}, error: {code}}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildFetchScript(
  responses: Array<{ assertUrl?: (url: string) => void; response: Response }>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const queue = [...responses];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    next.assertUrl?.(url);
    return Promise.resolve(next.response);
  };
  return { fetchImpl, calls };
}

const BASE_INPUT = {
  request: { prompt: 'a waving cat', durationSeconds: 5 },
  sourceImageDataUrl: 'data:image/png;base64,AAA=',
  auth: { accessToken: 'token' },
  sleepImpl: async () => {},
  pollIntervalMs: 1,
  pollTimeoutMs: 1_000,
};

void test('generateVideoViaGrok posts the job, polls to done, and returns the video url', async () => {
  let createBody: unknown;
  const script = buildFetchScript([
    {
      response: jsonResponse(200, { request_id: 'req-1' }),
    },
    { response: jsonResponse(200, { status: 'pending' }) },
    {
      assertUrl: (url) => assert.ok(url.endsWith('/videos/req-1')),
      response: jsonResponse(200, {
        status: 'done',
        video: { url: 'https://signed.example/video.mp4', duration: 5 },
      }),
    },
  ]);
  const fetchImpl: typeof fetch = (input, init) => {
    if (init?.method === 'POST') {
      createBody = JSON.parse(String(init.body));
    }
    return script.fetchImpl(input, init);
  };

  const result = await generateVideoViaGrok({ ...BASE_INPUT, fetchImpl });
  assert.equal(result.videoUrl, 'https://signed.example/video.mp4');
  assert.equal(result.durationSeconds, 5);
  assert.equal(result.model, 'grok-imagine-video-1.5');
  // 소스 이미지는 image: {url} 구조체로 실린다(S0 실측 계약)
  assert.deepEqual(createBody, {
    model: 'grok-imagine-video-1.5',
    prompt: 'a waving cat',
    duration: 5,
    image: { url: 'data:image/png;base64,AAA=' },
  });
});

void test('generateVideoViaGrok classifies auth, rate-limit, failed, and expired outcomes', async () => {
  // 401 → provider_auth (런타임의 1회 리프레시 재시도 대상)
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: buildFetchScript([
        { response: jsonResponse(401, { error: 'nope' }) },
      ]).fetchImpl,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.surface === 'provider_auth',
  );

  // 429 → provider_rate_limited
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: buildFetchScript([
        { response: jsonResponse(429, { error: 'slow down' }) },
      ]).fetchImpl,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_rate_limited',
  );

  // 잡 실패 → 사유 코드 포함, invalid 분류(§4.4)
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: buildFetchScript([
        { response: jsonResponse(200, { request_id: 'req-2' }) },
        {
          response: jsonResponse(200, {
            status: 'failed',
            error: { code: 'moderation', message: 'blocked' },
          }),
        },
      ]).fetchImpl,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_response_invalid' &&
      error.message.includes('moderation'),
  );

  // 잡 만료 → timeout 분류
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: buildFetchScript([
        { response: jsonResponse(200, { request_id: 'req-3' }) },
        { response: jsonResponse(200, { status: 'expired' }) },
      ]).fetchImpl,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_request_timeout',
  );
});

void test('generateVideoViaGrok reports structured unknown statuses without object base strings', async () => {
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: buildFetchScript([
        { response: jsonResponse(200, { request_id: 'req-unknown-status' }) },
        {
          response: jsonResponse(200, {
            status: { state: 'queued' },
          }),
        },
      ]).fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.reasonCode, 'provider_response_invalid');
      assert.match(error.message, /unknown status: \{"state":"queued"\}/u);
      assert.doesNotMatch(error.message, /\[object Object\]/u);
      return true;
    },
  );
});

void test('generateVideoViaGrok stops at the poll ceiling with a timeout classification', async () => {
  const pendingForever: typeof fetch = (input, init) =>
    Promise.resolve(
      init?.method === 'POST'
        ? jsonResponse(200, { request_id: 'req-4' })
        : jsonResponse(200, { status: 'pending' }),
    );
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      fetchImpl: pendingForever,
      pollTimeoutMs: 10,
      pollIntervalMs: 1,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_request_timeout',
  );
});
