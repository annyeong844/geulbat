import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { ApiShapeError, apiFetch, apiFetchOpaqueBlob } from './client.js';

function installApiClientTestBootstrap(
  t: test.TestContext,
  fetchImpl: typeof globalThis.fetch,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

void test('apiFetch returns validated json responses', async (t) => {
  installApiClientTestBootstrap(t, async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await apiFetch(
    '/api/test',
    undefined,
    (value): value is { ok: true } =>
      typeof value === 'object' &&
      value !== null &&
      (value as { ok?: unknown }).ok === true,
  );

  assert.deepEqual(response, { ok: true });
});

void test('apiFetch preserves Headers objects and tuple-array headers', async (t) => {
  const observedHeaders: Headers[] = [];
  installApiClientTestBootstrap(t, async (_input, init) => {
    observedHeaders.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await apiFetch(
    '/api/test',
    { headers: new Headers({ 'X-Headers-Object': 'preserved' }) },
    (value): value is { ok: true } =>
      typeof value === 'object' &&
      value !== null &&
      (value as { ok?: unknown }).ok === true,
  );
  await apiFetch(
    '/api/test',
    { headers: [['X-Tuple-Header', 'preserved']] },
    (value): value is { ok: true } =>
      typeof value === 'object' &&
      value !== null &&
      (value as { ok?: unknown }).ok === true,
  );

  assert.equal(observedHeaders[0]?.get('X-Headers-Object'), 'preserved');
  assert.equal(observedHeaders[1]?.get('X-Tuple-Header'), 'preserved');
});

void test('apiFetchOpaqueBlob transports an authenticated body without the preview range limit', async (t) => {
  installApiClientTestBootstrap(t, async (input, init) => {
    assert.equal(String(input), '/api/archive');
    assert.equal(init?.credentials, 'same-origin');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Range'), null);
    assert.equal(headers.get('X-Transfer'), 'opaque');
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });

  const blob = await apiFetchOpaqueBlob('/api/archive', {
    headers: { 'X-Transfer': 'opaque' },
  });

  assert.equal(blob.type, 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
});

void test('apiFetch throws ApiShapeError when response validation fails', async (t) => {
  installApiClientTestBootstrap(
    t,
    async () =>
      new Response(JSON.stringify({ ok: 'not-boolean' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );

  await assert.rejects(
    () =>
      apiFetch(
        '/api/test',
        undefined,
        (value): value is { ok: boolean } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { ok?: unknown }).ok === 'boolean',
      ),
    (error: unknown) => {
      assert.ok(error instanceof ApiShapeError);
      assert.equal(error.message, 'invalid API response shape for /api/test');
      return true;
    },
  );
});
