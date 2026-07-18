import test from 'node:test';
import assert from 'node:assert/strict';

import { DEV_TOKEN_HEADER_NAME } from '../auth/shell-auth.js';
import { ApiFetchError } from './client.js';
import {
  COMPUTER_FILE_API_SCOPE,
  FileSaveConflictError,
  getComputerFileScope,
  replaceBinaryFile,
  saveBinaryFile,
  saveFile,
  selectComputerDirectory,
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

void test('computer file APIs use root scope without a project id', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input, init) => {
    calls.push(String(input));
    if (String(input) === '/api/files/computer-scope') {
      return new Response(
        JSON.stringify({
          available: true,
          browseStartPath: 'Users/sample',
          browseShortcuts: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.root, 'computer');
    assert.equal(body.projectId, undefined);
    return new Response(
      JSON.stringify({
        ok: true,
        path: body.path,
        versionToken: 'computer-version',
        totalLines: 1,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const scope = await getComputerFileScope();
  assert.equal(scope.available, true);
  await saveFile(
    COMPUTER_FILE_API_SCOPE,
    'Users/sample/note.md',
    'hello',
    'v1',
  );
  assert.deepEqual(calls, ['/api/files/computer-scope', '/api/files/save']);
});

void test('selectComputerDirectory requests a native folder dialog from the current path', async (t) => {
  installApiTestBootstrap(t, async (input, init) => {
    assert.equal(String(input), '/api/files/select-directory');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      root: 'computer',
      initialPath: 'mnt/c/Users/user',
    });
    return new Response(
      JSON.stringify({
        status: 'selected',
        path: 'mnt/c/Users/user/Downloads/repo',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  assert.deepEqual(await selectComputerDirectory('mnt/c/Users/user'), {
    status: 'selected',
    path: 'mnt/c/Users/user/Downloads/repo',
  });
});

void test('saveFile maps stale write api conflict into FileSaveConflictError', async (t) => {
  installApiTestBootstrap(t, async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);
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
    () =>
      saveFile(COMPUTER_FILE_API_SCOPE, 'docs/sample.md', 'hello', 'token-1'),
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
    () =>
      saveFile(COMPUTER_FILE_API_SCOPE, 'docs/sample.md', 'hello', 'token-1'),
    (error: unknown) => error instanceof ApiFetchError,
  );
});

void test('saveBinaryFile uploads blob bytes before posting a contentRef to the binary save route', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);

    if (String(input).startsWith('/api/files/binary-inputs?')) {
      assert.equal(new Headers(init?.headers).get('content-type'), 'image/png');
      assert.ok(init?.body instanceof Blob);
      assert.deepEqual(
        new Uint8Array(await init.body.arrayBuffer()),
        new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      );
      return new Response(
        JSON.stringify({
          ok: true,
          contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000001',
          byteLength: 4,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    assert.equal(String(input), '/api/files/save-binary');
    assert.equal(
      new Headers(init?.headers).get('content-type'),
      'application/json',
    );
    const body = JSON.parse(String(init?.body)) as {
      root: string;
      path: string;
      contentRef: string;
      contentBase64?: string;
      mimeType: string;
    };
    assert.equal(body.root, 'computer');
    assert.equal(body.path, 'exports/demo.png');
    assert.equal(body.mimeType, 'image/png');
    assert.equal(
      body.contentRef,
      'file-binary-input:00000000-0000-0000-0000-000000000001',
    );
    assert.equal(body.contentBase64, undefined);
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
    COMPUTER_FILE_API_SCOPE,
    'exports/demo.png',
    new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])], {
      type: 'image/png',
    }),
  );

  assert.equal(response.ok, true);
  assert.equal(response.versionToken, 'binary-token');
  assert.deepEqual(calls, [
    '/api/files/binary-inputs?root=computer',
    '/api/files/save-binary',
  ]);
});

void test('saveBinaryFile deletes uploaded content refs when the save request fails', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input) => {
    calls.push(String(input));
    if (String(input).startsWith('/api/files/binary-inputs?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000005',
          byteLength: 1,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (String(input).startsWith('/api/files/save-binary')) {
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
    () =>
      saveBinaryFile(
        COMPUTER_FILE_API_SCOPE,
        'exports/demo.png',
        new Blob([new Uint8Array([0xff])], { type: 'image/png' }),
      ),
    (error: unknown) => error instanceof ApiFetchError,
  );
  assert.deepEqual(calls, [
    '/api/files/binary-inputs?root=computer',
    '/api/files/save-binary',
    '/api/files/binary-inputs?root=computer&contentRef=file-binary-input%3A00000000-0000-0000-0000-000000000005',
  ]);
});

void test('replaceBinaryFile uploads blob bytes before posting versionToken and contentRef', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get(DEV_TOKEN_HEADER_NAME), null);
    if (String(input).startsWith('/api/files/binary-inputs?')) {
      assert.equal(new Headers(init?.headers).get('content-type'), 'image/png');
      assert.ok(init?.body instanceof Blob);
      assert.deepEqual(
        new Uint8Array(await init.body.arrayBuffer()),
        new Uint8Array([0x00, 0x01, 0x02, 0xff]),
      );
      return new Response(
        JSON.stringify({
          ok: true,
          contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000002',
          byteLength: 4,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    assert.equal(
      new Headers(init?.headers).get('content-type'),
      'application/json',
    );
    assert.equal(String(input), '/api/files/replace-binary');
    const body = JSON.parse(String(init?.body)) as {
      root: string;
      path: string;
      contentRef: string;
      contentBase64?: string;
      mimeType: string;
      versionToken: string;
    };
    assert.equal(body.root, 'computer');
    assert.equal(body.path, 'exports/demo.png');
    assert.equal(body.mimeType, 'image/png');
    assert.equal(body.versionToken, 'token-1');
    assert.equal(
      body.contentRef,
      'file-binary-input:00000000-0000-0000-0000-000000000002',
    );
    assert.equal(body.contentBase64, undefined);
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
    COMPUTER_FILE_API_SCOPE,
    'exports/demo.png',
    new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])], {
      type: 'image/png',
    }),
    'token-1',
  );

  assert.equal(response.ok, true);
  assert.equal(response.versionToken, 'binary-token-2');
  assert.deepEqual(calls, [
    '/api/files/binary-inputs?root=computer',
    '/api/files/replace-binary',
  ]);
});

void test('replaceBinaryFile maps stale write api conflict into FileSaveConflictError', async (t) => {
  const calls: string[] = [];
  installApiTestBootstrap(t, async (input) => {
    calls.push(String(input));
    if (String(input).startsWith('/api/files/binary-inputs?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000003',
          byteLength: 1,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (String(input).startsWith('/api/files/replace-binary')) {
      return new Response(
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
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await assert.rejects(
    () =>
      replaceBinaryFile(
        COMPUTER_FILE_API_SCOPE,
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
  assert.deepEqual(calls, [
    '/api/files/binary-inputs?root=computer',
    '/api/files/replace-binary',
    '/api/files/binary-inputs?root=computer&contentRef=file-binary-input%3A00000000-0000-0000-0000-000000000003',
  ]);
});

void test('saveBinaryFile uses an octet-stream upload content type for untyped blobs', async (t) => {
  installApiTestBootstrap(t, async (input, init) => {
    if (String(input).startsWith('/api/files/binary-inputs?')) {
      assert.equal(
        new Headers(init?.headers).get('content-type'),
        'application/octet-stream',
      );
      return new Response(
        JSON.stringify({
          ok: true,
          contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000004',
          byteLength: 1,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        path: 'exports/demo.bin',
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
    COMPUTER_FILE_API_SCOPE,
    'exports/demo.bin',
    new Blob([new Uint8Array([0xff])]),
  );

  assert.equal(response.ok, true);
});
