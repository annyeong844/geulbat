import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { brandProjectId } from '../id-brand-helpers.js';
import { ApiFetchError } from './client.js';
import { deleteThread, ThreadDeleteConflictError } from './threads.js';

function installApiTestBootstrap(
  t: test.TestContext,
  fetchImpl: typeof globalThis.fetch,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

void test('deleteThread maps active run api conflict into ThreadDeleteConflictError', async (t) => {
  installApiTestBootstrap(t, async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(
      (init?.headers as Record<string, string>)[DEV_TOKEN_HEADER_NAME],
      undefined,
    );
    return new Response(
      JSON.stringify({
        code: 'conflict_active_run',
        message: 'thread has an active run',
        threadId: '00000000-0000-4000-8000-000000000001',
        activeRunId: 'run-1',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  await assert.rejects(
    () =>
      deleteThread(
        '00000000-0000-4000-8000-000000000001',
        brandProjectId('workspace'),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ThreadDeleteConflictError);
      assert.equal(
        error.conflict.threadId,
        '00000000-0000-4000-8000-000000000001',
      );
      assert.equal(error.conflict.activeRunId, 'run-1');
      return true;
    },
  );
});

void test('deleteThread preserves unrelated api fetch failures', async (t) => {
  installApiTestBootstrap(
    t,
    async () =>
      new Response(
        JSON.stringify({
          code: 'internal',
          message: 'internal server error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );

  await assert.rejects(
    () =>
      deleteThread(
        '00000000-0000-4000-8000-000000000001',
        brandProjectId('workspace'),
      ),
    (error: unknown) => error instanceof ApiFetchError,
  );
});
