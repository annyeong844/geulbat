import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import type { PublicHttpReadRuntime } from '../../utils/public-http-read-port.js';
import { ImageGenerationError } from '../contract.js';
import {
  generateVideoViaGrok,
  type GrokVideoCreateRequest,
} from './grok-video-provider.js';

// 실 API 형태는 S0 실측(2026-07-13): POST → {request_id}, GET →
// {status: pending|done|failed|expired, video: {url, duration}, error: {code}}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createPublicHttpRead(fetchImpl: typeof fetch): PublicHttpReadRuntime {
  return {
    async request(input) {
      const response = await fetchImpl(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        ok: true,
        status: response.status,
        location: response.headers.get('location'),
        contentType: response.headers.get('content-type'),
        contentLength: bytes.byteLength,
        bodyBase64: bytes.toString('base64'),
      };
    },
  };
}

function createRequestFromFetch(
  fetchImpl: typeof fetch,
): GrokVideoCreateRequest {
  return async (input) => {
    const response = await fetchImpl(input.requestUrl, {
      method: 'POST',
      headers: input.headers,
      body: input.serializedPayload,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) {
      throw Object.assign(new Error('fixture create request failed'), {
        status: response.status,
      });
    }
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('fixture create response is invalid'), {
        status: response.status,
      });
    }
    return body as Record<string, unknown>;
  };
}

function buildFetchScript(
  responses: Array<{ assertUrl?: (url: string) => void; response: Response }>,
): {
  fetchImpl: typeof fetch;
  publicHttpRead: PublicHttpReadRuntime;
  calls: string[];
} {
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
  const publicHttpRead = createPublicHttpRead(fetchImpl);
  return { fetchImpl, publicHttpRead, calls };
}

function fetchScriptInput(script: ReturnType<typeof buildFetchScript>): {
  createRequestImpl: GrokVideoCreateRequest;
  publicHttpRead: PublicHttpReadRuntime;
} {
  return {
    createRequestImpl: createRequestFromFetch(script.fetchImpl),
    publicHttpRead: script.publicHttpRead,
  };
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
  const createRequestImpl = createRequestFromFetch(script.fetchImpl);

  const result = await generateVideoViaGrok({
    ...BASE_INPUT,
    createRequestImpl: async (request) => {
      createBody = JSON.parse(request.serializedPayload);
      return createRequestImpl(request);
    },
    publicHttpRead: script.publicHttpRead,
  });
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

void test('generateVideoViaGrok can delegate only the billable create request to a durable owner', async () => {
  const events: string[] = [];
  const poll = buildFetchScript([
    {
      assertUrl: (url) => assert.ok(url.endsWith('/videos/req-owned')),
      response: jsonResponse(200, {
        status: 'done',
        video: { url: 'https://signed.example/owned.mp4', duration: 5 },
      }),
    },
  ]);

  const result = await generateVideoViaGrok({
    ...BASE_INPUT,
    publicHttpRead: poll.publicHttpRead,
    createRequestImpl: async (request) => {
      assert.equal(request.headers.get('Accept'), 'application/json');
      assert.equal(request.headers.get('Authorization'), 'Bearer token');
      assert.equal(
        JSON.parse(request.serializedPayload).prompt,
        'a waving cat',
      );
      events.push('create-owned');
      return { request_id: 'req-owned' };
    },
    onRequestCreated: async (requestId) => {
      events.push(`persist:${requestId}`);
    },
  });

  assert.equal(result.videoUrl, 'https://signed.example/owned.mp4');
  assert.deepEqual(events, ['create-owned', 'persist:req-owned']);
  assert.deepEqual(poll.calls, ['GET https://api.x.ai/v1/videos/req-owned']);
});

void test('generateVideoViaGrok persists a new request id before polling and replacement polling skips POST', async () => {
  const events: string[] = [];
  const firstFetch: typeof fetch = (input, init) => {
    events.push(init?.method === 'POST' ? 'post' : `poll:${String(input)}`);
    return Promise.resolve(
      init?.method === 'POST'
        ? jsonResponse(200, { request_id: 'req-durable' })
        : jsonResponse(200, {
            status: 'done',
            video: { url: 'https://signed.example/video.mp4', duration: 5 },
          }),
    );
  };
  await generateVideoViaGrok({
    ...BASE_INPUT,
    createRequestImpl: createRequestFromFetch(firstFetch),
    publicHttpRead: createPublicHttpRead(firstFetch),
    onRequestCreated: async (requestId) => {
      events.push(`persist:${requestId}`);
    },
  });
  assert.deepEqual(events.slice(0, 3), [
    'post',
    'persist:req-durable',
    'poll:https://api.x.ai/v1/videos/req-durable',
  ]);

  const replacement = buildFetchScript([
    {
      assertUrl: (url) => assert.ok(url.endsWith('/videos/req-durable')),
      response: jsonResponse(200, {
        status: 'done',
        video: { url: 'https://signed.example/video.mp4', duration: 5 },
      }),
    },
  ]);
  await generateVideoViaGrok({
    ...BASE_INPUT,
    requestId: 'req-durable',
    publicHttpRead: replacement.publicHttpRead,
  });
  assert.deepEqual(replacement.calls, [
    'GET https://api.x.ai/v1/videos/req-durable',
  ]);
});

void test('generateVideoViaGrok fails closed when the poll owner is unavailable', async () => {
  let createRequests = 0;
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      requestId: 'req-durable',
      createRequestImpl: async () => {
        createRequests += 1;
        throw new Error('create owner must not run');
      },
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_network_failed' &&
      /owner is unavailable/u.test(error.message),
  );
  assert.equal(createRequests, 0);
});

void test('generateVideoViaGrok classifies auth, rate-limit, failed, and expired outcomes', async () => {
  // 401 → provider_auth (런타임의 1회 리프레시 재시도 대상)
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      ...fetchScriptInput(
        buildFetchScript([{ response: jsonResponse(401, { error: 'nope' }) }]),
      ),
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.surface === 'provider_auth',
  );

  // 429 → provider_rate_limited
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      ...fetchScriptInput(
        buildFetchScript([
          { response: jsonResponse(429, { error: 'slow down' }) },
        ]),
      ),
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_rate_limited',
  );

  // 잡 실패 → 사유 코드 포함, invalid 분류(§4.4)
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      ...fetchScriptInput(
        buildFetchScript([
          { response: jsonResponse(200, { request_id: 'req-2' }) },
          {
            response: jsonResponse(200, {
              status: 'failed',
              error: { code: 'moderation', message: 'blocked' },
            }),
          },
        ]),
      ),
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
      ...fetchScriptInput(
        buildFetchScript([
          { response: jsonResponse(200, { request_id: 'req-3' }) },
          { response: jsonResponse(200, { status: 'expired' }) },
        ]),
      ),
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
      ...fetchScriptInput(
        buildFetchScript([
          { response: jsonResponse(200, { request_id: 'req-unknown-status' }) },
          {
            response: jsonResponse(200, {
              status: { state: 'queued' },
            }),
          },
        ]),
      ),
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
  let nowMs = 0;
  const script = buildFetchScript([
    { response: jsonResponse(200, { request_id: 'req-4' }) },
    ...Array.from({ length: 100 }, () => ({
      response: jsonResponse(200, { status: 'pending' }),
    })),
  ]);
  await assert.rejects(
    generateVideoViaGrok({
      ...BASE_INPUT,
      ...fetchScriptInput(script),
      now: () => nowMs,
      sleepImpl: async (ms) => {
        nowMs += ms;
      },
      pollTimeoutMs: 10,
      pollIntervalMs: 1,
    }),
    (error: unknown) =>
      error instanceof ImageGenerationError &&
      error.reasonCode === 'provider_request_timeout',
  );
  assert.equal(nowMs, 10);
  assert.equal(
    script.calls.filter((call) => call.startsWith('GET ')).length,
    9,
  );
});
