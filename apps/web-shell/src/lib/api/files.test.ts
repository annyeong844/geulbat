import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { ApiFetchError } from './client.js';
import {
  FileSaveConflictError,
  replaceBinaryFile,
  saveBinaryFile,
  saveFile,
} from './files.js';

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

void test('saveFile maps stale write api conflict into FileSaveConflictError', async (t) => {
  installApiTestBootstrap(t, async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(
      (init?.headers as Record<string, string>)[DEV_TOKEN_HEADER_NAME],
      undefined,
    );
    return new Response(
      JSON.stringify({
        code: 'conflict_stale_write',
        message: 'stale write',
        path: 'docs/sample.md',
        currentVersionToken: 'token-2',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  await assert.rejects(
    () => saveFile('workspace', 'docs/sample.md', 'hello', 'token-1'),
    (error: unknown) => {
      assert.ok(error instanceof FileSaveConflictError);
      assert.equal(error.conflict.path, 'docs/sample.md');
      assert.equal(error.conflict.currentVersionToken, 'token-2');
      return true;
    },
  );
});

void test('saveFile preserves unrelated api fetch failures', async (t) => {
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
    () => saveFile('workspace', 'docs/sample.md', 'hello', 'token-1'),
    (error: unknown) => error instanceof ApiFetchError,
  );
});

void test('saveBinaryFile posts base64 content to the binary save route', async (t) => {
  installApiTestBootstrap(t, async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(
      (init?.headers as Record<string, string>)[DEV_TOKEN_HEADER_NAME],
      undefined,
    );
    assert.equal(
      (init?.headers as Record<string, string>)['Content-Type'],
      'application/json',
    );
    const body = JSON.parse(String(init?.body)) as {
      projectId: string;
      path: string;
      contentBase64: string;
      mimeType: string;
    };
    assert.equal(body.projectId, 'workspace');
    assert.equal(body.path, 'exports/demo.png');
    assert.equal(body.mimeType, 'image/png');
    assert.equal(body.contentBase64, 'AAEC/w==');
    return new Response(
      JSON.stringify({
        path: body.path,
        versionToken: 'binary-token',
        totalLines: 0,
        ok: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  const response = await saveBinaryFile(
    'workspace',
    'exports/demo.png',
    new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])], {
      type: 'image/png',
    }),
  );

  assert.equal(response.ok, true);
  assert.equal(response.versionToken, 'binary-token');
});

void test('replaceBinaryFile posts versionToken to the binary replace route', async (t) => {
  installApiTestBootstrap(t, async (input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(
      (init?.headers as Record<string, string>)[DEV_TOKEN_HEADER_NAME],
      undefined,
    );
    assert.equal(
      (init?.headers as Record<string, string>)['Content-Type'],
      'application/json',
    );
    assert.equal(String(input), '/api/files/replace-binary');
    const body = JSON.parse(String(init?.body)) as {
      projectId: string;
      path: string;
      contentBase64: string;
      mimeType: string;
      versionToken: string;
    };
    assert.equal(body.projectId, 'workspace');
    assert.equal(body.path, 'exports/demo.png');
    assert.equal(body.mimeType, 'image/png');
    assert.equal(body.versionToken, 'token-1');
    assert.equal(body.contentBase64, 'AAEC/w==');
    return new Response(
      JSON.stringify({
        path: body.path,
        versionToken: 'binary-token-2',
        totalLines: 0,
        ok: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  const response = await replaceBinaryFile(
    'workspace',
    'exports/demo.png',
    new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])], {
      type: 'image/png',
    }),
    'token-1',
  );

  assert.equal(response.ok, true);
  assert.equal(response.versionToken, 'binary-token-2');
});

void test('replaceBinaryFile maps stale write api conflict into FileSaveConflictError', async (t) => {
  installApiTestBootstrap(
    t,
    async () =>
      new Response(
        JSON.stringify({
          code: 'conflict_stale_write',
          message: 'stale write',
          path: 'exports/demo.png',
          currentVersionToken: 'token-2',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );

  await assert.rejects(
    () =>
      replaceBinaryFile(
        'workspace',
        'exports/demo.png',
        new Blob([new Uint8Array([0xff])], {
          type: 'image/png',
        }),
        'token-1',
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSaveConflictError);
      assert.equal(error.conflict.path, 'exports/demo.png');
      assert.equal(error.conflict.currentVersionToken, 'token-2');
      return true;
    },
  );
});
