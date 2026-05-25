import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { ApiShapeError, apiFetch } from './client.js';

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
    assert.equal(
      (init?.headers as Record<string, string>)[DEV_TOKEN_HEADER_NAME],
      undefined,
    );
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
