import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { ApiFetchError } from './client.js';
import {
  branchThread,
  deleteThread,
  prepareThreadProviderTransition,
  ThreadDeleteConflictError,
} from './threads.js';

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
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);
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
    () => deleteThread('00000000-0000-4000-8000-000000000001'),
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

void test('branchThread posts upToEntryId and validates the branch response', async (t) => {
  installApiTestBootstrap(t, async (input, init) => {
    assert.equal(
      String(input),
      '/api/threads/00000000-0000-4000-8000-000000000001/branch',
    );
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      upToEntryId: 'entry-3',
    });
    return new Response(
      JSON.stringify({
        ok: true,
        threadId: '00000000-0000-4000-8000-000000000002',
        sourceThreadId: '00000000-0000-4000-8000-000000000001',
        copiedMessageCount: 3,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const branched = await branchThread(
    '00000000-0000-4000-8000-000000000001',
    'entry-3',
  );
  assert.equal(branched.threadId, '00000000-0000-4000-8000-000000000002');
  assert.equal(branched.copiedMessageCount, 3);
});

void test('prepareThreadProviderTransition posts the source selection before accepting a compacted response', async (t) => {
  installApiTestBootstrap(t, async (input, init) => {
    assert.equal(
      String(input),
      '/api/threads/00000000-0000-4000-8000-000000000001/provider-transition',
    );
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      sourceModelId: 'grok-4.5',
      targetModelId: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    return new Response(
      JSON.stringify({
        ok: true,
        status: 'compacted',
        threadId: '00000000-0000-4000-8000-000000000001',
        sourceModelId: 'grok-4.5',
        targetModelId: 'gpt-5.6-sol',
        compactionEntryId: 'entry-8',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const response = await prepareThreadProviderTransition(
    '00000000-0000-4000-8000-000000000001',
    {
      sourceModelId: 'grok-4.5',
      targetModelId: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
  );
  assert.equal(response.status, 'compacted');
  if (response.status === 'compacted') {
    assert.equal(response.compactionEntryId, 'entry-8');
  }
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
    () => deleteThread('00000000-0000-4000-8000-000000000001'),
    (error: unknown) => error instanceof ApiFetchError,
  );
});
