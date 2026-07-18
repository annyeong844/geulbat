import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { assertThreadId } from '@geulbat/protocol/ids';
import { ApiFetchError } from './client.js';
import { saveArtifactRuntimePersistenceState } from './artifact-runtime-persistence.js';

const TEST_THREAD_ID = assertThreadId('00000000-0000-4000-8000-000000000001');

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

function createSaveRequest() {
  return {
    threadId: TEST_THREAD_ID,
    renderer: 'js',
    artifactId: 'artifact',
    persistenceEpoch: 0,
    state: { count: 1 },
    expectedRevision: null,
  } as const;
}

void test('saveArtifactRuntimePersistenceState uploads state before posting a stateRef save request', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);

    if (String(input) === '/api/artifact-runtime-persistence/state-inputs') {
      assert.equal(
        new Headers(init?.headers).get('content-type'),
        'application/octet-stream',
      );
      assert.ok(init?.body instanceof Blob);
      assert.equal(await init.body.text(), JSON.stringify({ count: 1 }));
      return new Response(
        JSON.stringify({
          ok: true,
          stateRef:
            'artifact-runtime-state-input:00000000-0000-4000-8000-000000000001',
          byteLength: 11,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    assert.equal(String(input), '/api/artifact-runtime-persistence/save');
    assert.equal(
      new Headers(init?.headers).get('content-type'),
      'application/json',
    );
    const body = JSON.parse(String(init?.body)) as {
      artifactId: string;
      state?: unknown;
      stateRef: string;
    };
    assert.equal('projectId' in body, false);
    assert.equal(body.artifactId, 'artifact');
    assert.equal(body.state, undefined);
    assert.equal(
      body.stateRef,
      'artifact-runtime-state-input:00000000-0000-4000-8000-000000000001',
    );
    return new Response(JSON.stringify({ revision: 'revision-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response =
    await saveArtifactRuntimePersistenceState(createSaveRequest());

  assert.equal(response.revision, 'revision-1');
  assert.deepEqual(calls, [
    '/api/artifact-runtime-persistence/state-inputs',
    '/api/artifact-runtime-persistence/save',
  ]);
});

void test('saveArtifactRuntimePersistenceState deletes uploaded state refs when the save request fails', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input) => {
    calls.push(String(input));
    if (String(input) === '/api/artifact-runtime-persistence/state-inputs') {
      return new Response(
        JSON.stringify({
          ok: true,
          stateRef:
            'artifact-runtime-state-input:00000000-0000-4000-8000-000000000003',
          byteLength: 11,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (String(input) === '/api/artifact-runtime-persistence/save') {
      return new Response(
        JSON.stringify({
          code: 'internal',
          message: 'save failed',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await assert.rejects(
    () => saveArtifactRuntimePersistenceState(createSaveRequest()),
    (error: unknown) => error instanceof ApiFetchError,
  );
  assert.deepEqual(calls, [
    '/api/artifact-runtime-persistence/state-inputs',
    '/api/artifact-runtime-persistence/save',
    '/api/artifact-runtime-persistence/state-inputs?stateRef=artifact-runtime-state-input%3A00000000-0000-4000-8000-000000000003',
  ]);
});

void test('saveArtifactRuntimePersistenceState preserves caller-provided stateRef requests', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input, init) => {
    calls.push(String(input));
    assert.equal(String(input), '/api/artifact-runtime-persistence/save');
    assert.equal(
      new Headers(init?.headers).get('content-type'),
      'application/json',
    );
    const body = JSON.parse(String(init?.body)) as {
      stateRef: string;
    };
    assert.equal(
      body.stateRef,
      'artifact-runtime-state-input:00000000-0000-4000-8000-000000000002',
    );
    return new Response(JSON.stringify({ revision: 'revision-2' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await saveArtifactRuntimePersistenceState({
    threadId: TEST_THREAD_ID,
    renderer: 'js',
    artifactId: 'artifact',
    persistenceEpoch: 0,
    stateRef:
      'artifact-runtime-state-input:00000000-0000-4000-8000-000000000002',
    expectedRevision: null,
  });

  assert.equal(response.revision, 'revision-2');
  assert.deepEqual(calls, ['/api/artifact-runtime-persistence/save']);
});
