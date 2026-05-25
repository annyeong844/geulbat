import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  HttpMetadataProbeRuntimeError,
  REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  probeHttpMetadata,
  type HttpMetadataProbeRequestTransport,
} from './http-metadata-probe.js';

function transport(
  responses: Array<{
    status: number;
    location?: string | null;
    contentType?: string | null;
    contentLength?: number | null;
    body?: Buffer;
  }>,
): HttpMetadataProbeRequestTransport {
  let index = 0;
  return async (_url, options) => {
    const response = responses[index++];
    assert.ok(response, 'missing response fixture');
    return {
      status: response.status,
      location: response.location ?? null,
      contentType: response.contentType ?? null,
      contentLength: response.contentLength ?? null,
      bytesRead:
        options.method === 'GET'
          ? (response.body ?? Buffer.alloc(0)).byteLength
          : 0,
    };
  };
}

void test('probeHttpMetadata returns ok for HEAD 2xx on allowlisted CDN host', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: transport([
      {
        status: 200,
        contentType: 'application/javascript',
        contentLength: 1234,
      },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'HEAD');
  assert.equal(result.bytesRead, 0);
  assert.equal(result.finalUrl, 'https://esm.sh/canvas-confetti@1.9.3');
  assert.match(result.timingBucket, /^(lt_100ms|lt_500ms|lt_2s|gte_2s)$/u);
  assert.equal(
    result.policy.allowlistId,
    REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  );
});

void test('probeHttpMetadata falls back from HEAD 405 to bounded GET', async () => {
  const result = await probeHttpMetadata({
    url: 'https://cdn.jsdelivr.net/npm/water.css@2.0.0/out/water.css',
    transport: transport([
      { status: 405 },
      {
        status: 200,
        contentType: 'text/css',
        contentLength: 42,
        body: Buffer.from('body'),
      },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'GET');
  assert.equal(result.bytesRead, 4);
});

void test('probeHttpMetadata follows redirect from bounded GET fallback', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: transport([
      { status: 405 },
      {
        status: 302,
        location: 'https://esm.sh/canvas-confetti@1.9.3?target=es2022',
      },
      { status: 200, contentType: 'application/javascript' },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.finalUrl,
    'https://esm.sh/canvas-confetti@1.9.3?target=es2022',
  );
  assert.equal(result.redirectChain.length, 1);
});

void test('probeHttpMetadata reports final non-2xx as http_status', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/missing@1.0.0',
    transport: transport([{ status: 404 }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'http_status');
  assert.equal(result.status, 404);
});

void test('probeHttpMetadata rejects initial URL outside allowlist', async () => {
  const result = await probeHttpMetadata({
    url: 'https://example.com/canvas-confetti@1.9.3',
    transport: transport([{ status: 200 }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'disallowed_origin');
});

void test('probeHttpMetadata rejects deceptive allowlist suffix hosts', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh.evil.example/canvas-confetti@1.9.3',
    transport: transport([{ status: 200 }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'disallowed_origin');
});

void test('probeHttpMetadata rejects http URLs for dependency metadata probing', async () => {
  const result = await probeHttpMetadata({
    url: 'http://esm.sh/canvas-confetti@1.9.3',
    transport: transport([{ status: 200 }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'disallowed_origin');
});

void test('probeHttpMetadata classifies unsupported schemes separately from malformed URLs', async () => {
  const malformed = await probeHttpMetadata({
    url: 'not a URL',
    transport: transport([{ status: 200 }]),
  });
  const result = await probeHttpMetadata({
    url: 'ftp://example.com/canvas-confetti.js',
    transport: transport([{ status: 200 }]),
  });

  assert.equal(malformed.ok, false);
  assert.equal(malformed.reasonCode, 'invalid_url');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsupported_scheme');
});

void test('probeHttpMetadata classifies timeout failures', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: async () => {
      throw new HttpMetadataProbeRuntimeError(
        'timeout',
        'dependency metadata probe timeout',
      );
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'timeout');
});

void test('probeHttpMetadata classifies response byte budget failures', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: async () => {
      throw new HttpMetadataProbeRuntimeError(
        'response_too_large',
        'dependency metadata probe response byte budget exceeded',
      );
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'response_too_large');
});

void test('probeHttpMetadata rejects redirect outside allowlist', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: transport([
      { status: 302, location: 'https://example.com/canvas-confetti.js' },
    ]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'disallowed_origin');
});

void test('probeHttpMetadata classifies redirect budget overflow as unsafe_redirect', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: transport(
      Array.from({ length: 6 }, (_, index) => ({
        status: 302,
        location: `https://esm.sh/canvas-confetti@1.9.3?r=${index}`,
      })),
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsafe_redirect');
});

void test('probeHttpMetadata rejects protocol-relative redirect to unsafe host', async () => {
  const result = await probeHttpMetadata({
    url: 'https://esm.sh/canvas-confetti@1.9.3',
    transport: transport([{ status: 302, location: '//127.0.0.1/pkg.js' }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsafe_redirect');
});
