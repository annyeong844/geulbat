import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  mkdir,
  readFile as fsReadFile,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';

import { isComputerFileScopeResponse } from '@geulbat/protocol/files';
import { createBinaryVersionToken } from './daemon/files/version-token.js';
import { readFileBinaryInputRefPath } from './daemon/files/binary-input-ref-store.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('authenticated computer file scope route omits the raw host root', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/files/computer-scope`,
        { headers: authHeaders() },
      );
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.equal(isComputerFileScopeResponse(body), true);
      if (daemonContext.computerFileScope) {
        assert.equal(
          JSON.stringify(body).includes(daemonContext.computerFileScope.root),
          false,
        );
      }
    },
    { daemonContext },
  );
});

void test('authenticated file routes resolve root=computer without a project id', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  daemonContext.computerFileScope = {
    root: computerFileRoot,
    browseShortcuts: [],
  };
  const relativePath = `computer-root-${randomUUID()}.md`;
  const absolutePath = join(computerFileRoot, relativePath);
  await mkdir(computerFileRoot, { recursive: true });
  await fsWriteFile(absolutePath, '# computer root\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/files/read?root=computer&path=${encodeURIComponent(relativePath)}`,
          { headers: authHeaders() },
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as { content: string };
        assert.equal(body.content, '# computer root\n');

        const ambiguous = await fetch(
          `http://127.0.0.1:${port}/api/files/tree?root=computer&projectId=workspace`,
          { headers: authHeaders() },
        );
        assert.equal(ambiguous.status, 400);
      },
      { daemonContext },
    );
  } finally {
    await rm(absolutePath, { force: true });
  }
});

void test('authenticated files/read route returns file contents', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-read-${randomUUID()}`;
  const relativePath = `${dirName}/note.md`;
  const absolutePath = join(computerFileRoot, dirName, 'note.md');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, '# route read\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/files/read?root=computer&path=${encodeURIComponent(relativePath)}`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          path: string;
          content: string;
          versionToken: string;
        };
        assert.equal(body.path, relativePath);
        assert.equal(body.content, '# route read\n');
        assert.equal(typeof body.versionToken, 'string');
        assert.ok(body.versionToken.length > 0);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/raw route streams the complete body with explicit content guards', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-raw-${randomUUID()}`;
  const relativePath = `${dirName}/asset.png`;
  const absolutePath = join(computerFileRoot, relativePath);
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, payload);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/files/raw?root=computer&path=${encodeURIComponent(relativePath)}`,
          { headers: authHeaders() },
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(
          response.headers.get('content-length'),
          String(payload.byteLength),
        );
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/raw route serves bounded and open-ended byte ranges', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-raw-range-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, relativePath);
  const payload = Buffer.from('0123456789', 'utf8');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, payload);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const url = `http://127.0.0.1:${port}/api/files/raw?root=computer&path=${encodeURIComponent(relativePath)}`;
        const bounded = await fetch(url, {
          headers: authHeaders({ Range: 'bytes=2-5' }),
        });
        assert.equal(bounded.status, 206);
        assert.equal(bounded.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(bounded.headers.get('content-length'), '4');
        assert.deepEqual(
          Buffer.from(await bounded.arrayBuffer()),
          Buffer.from('2345', 'utf8'),
        );

        const openEnded = await fetch(url, {
          headers: authHeaders({ Range: 'bytes=6-' }),
        });
        assert.equal(openEnded.status, 206);
        assert.equal(openEnded.headers.get('content-range'), 'bytes 6-9/10');
        assert.equal(openEnded.headers.get('content-length'), '4');
        assert.deepEqual(
          Buffer.from(await openEnded.arrayBuffer()),
          Buffer.from('6789', 'utf8'),
        );
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/raw route ignores malformed and suffix range syntax', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-raw-range-fallback-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, relativePath);
  const payload = Buffer.from('0123456789', 'utf8');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, payload);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const url = `http://127.0.0.1:${port}/api/files/raw?root=computer&path=${encodeURIComponent(relativePath)}`;
        for (const range of ['bytes=-4', 'bytes=5-2']) {
          const response = await fetch(url, {
            headers: authHeaders({ Range: range }),
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-range'), null);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
        }
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/raw route reports unsatisfiable ranges', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-raw-unsatisfiable-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, Buffer.from('0123', 'utf8'));

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/files/raw?root=computer&path=${encodeURIComponent(relativePath)}`,
          { headers: authHeaders({ Range: 'bytes=10-' }) },
        );

        assert.equal(response.status, 416);
        assert.equal(response.headers.get('content-range'), 'bytes */4');
        assert.equal(await response.text(), '');
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/tree route reads the computer root', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const relativePath = `route-tree-${randomUUID()}.md`;
  const absolutePath = join(computerFileRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, '# route tree\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/files/tree?root=computer`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          root: string;
          tree: Array<{ path: string; type: string }>;
        };
        assert.equal(body.root, 'computer');
        assert.ok(body.tree.some((entry) => entry.path === relativePath));
      },
      { daemonContext },
    );
  } finally {
    await rm(absolutePath, { force: true });
  }
});

void test('authenticated files/save route creates a new file and returns canonical metadata', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const relativePath = `route-save-create-${randomUUID()}.md`;
  const absolutePath = join(computerFileRoot, relativePath);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const saveRes = await fetch(`http://127.0.0.1:${port}/api/files/save`, {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            root: 'computer',
            path: relativePath,
            content: '# route save\nsecond line\n',
            versionToken: '',
          }),
        });

        assert.equal(saveRes.status, 200);
        const body = (await saveRes.json()) as {
          path: string;
          versionToken: string;
          totalLines: number;
          ok: boolean;
        };
        assert.equal(body.ok, true);
        assert.equal(body.path, relativePath);
        assert.equal(body.totalLines, 2);
        assert.equal(typeof body.versionToken, 'string');
        assert.ok(body.versionToken.length > 0);
        assert.equal(
          await fsReadFile(absolutePath, 'utf8'),
          '# route save\nsecond line\n',
        );
      },
      { daemonContext },
    );
  } finally {
    await rm(absolutePath, { force: true });
  }
});

void test('authenticated files/save route surfaces stale_write conflicts', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-save-${randomUUID()}`;
  const relativePath = `${dirName}/draft.md`;
  const absolutePath = join(computerFileRoot, dirName, 'draft.md');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, 'first\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const readRes = await fetch(
          `http://127.0.0.1:${port}/api/files/read?root=computer&path=${encodeURIComponent(relativePath)}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(readRes.status, 200);
        const readBody = (await readRes.json()) as { versionToken: string };

        await fsWriteFile(absolutePath, 'second\n', 'utf8');

        const saveRes = await fetch(`http://127.0.0.1:${port}/api/files/save`, {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            root: 'computer',
            path: relativePath,
            content: 'third\n',
            versionToken: readBody.versionToken,
          }),
        });

        assert.equal(saveRes.status, 409);
        const body = (await saveRes.json()) as {
          code: string;
          path: string;
          currentVersionToken: string;
        };
        assert.equal(body.code, 'conflict_stale_write');
        assert.equal(body.path, relativePath);
        assert.equal(typeof body.currentVersionToken, 'string');
        assert.ok(body.currentVersionToken.length > 0);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/manage route performs a real mkdir, rename, and delete lifecycle', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-manage-${randomUUID()}`;
  const createdPath = `${dirName}/created`;
  const renamedPath = `${dirName}/renamed`;
  const notePath = 'note.txt';

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const manage = (body: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}/api/files/manage`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ root: 'computer', ...body }),
          });

        const mkdirResponse = await manage({
          operation: 'mkdir',
          path: createdPath,
        });
        assert.equal(mkdirResponse.status, 200);
        assert.deepEqual(await mkdirResponse.json(), {
          ok: true,
          operation: 'mkdir',
          path: createdPath,
        });

        await fsWriteFile(
          join(computerFileRoot, createdPath, notePath),
          'managed file\n',
          'utf8',
        );
        const renameResponse = await manage({
          operation: 'rename',
          path: createdPath,
          destination: renamedPath,
        });
        assert.equal(renameResponse.status, 200);
        assert.deepEqual(await renameResponse.json(), {
          ok: true,
          operation: 'rename',
          path: createdPath,
          destination: renamedPath,
        });
        assert.equal(
          await fsReadFile(
            join(computerFileRoot, renamedPath, notePath),
            'utf8',
          ),
          'managed file\n',
        );

        const deleteResponse = await manage({
          operation: 'delete',
          path: renamedPath,
        });
        assert.equal(deleteResponse.status, 200);
        assert.deepEqual(await deleteResponse.json(), {
          ok: true,
          operation: 'delete',
          path: renamedPath,
        });
        await assert.rejects(
          fsReadFile(join(computerFileRoot, renamedPath, notePath), 'utf8'),
        );
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/manage route rejects invalid operations and unsafe roots', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const sentinelName = `route-manage-root-${randomUUID()}.txt`;
  const sentinelPath = join(computerFileRoot, sentinelName);

  await mkdir(computerFileRoot, { recursive: true });
  await fsWriteFile(sentinelPath, 'keep root\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const manage = (body: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}/api/files/manage`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
          });

        const invalidOperation = await manage({
          root: 'computer',
          operation: 'copy',
          path: sentinelName,
        });
        assert.equal(invalidOperation.status, 400);
        assert.deepEqual(await invalidOperation.json(), {
          code: 'bad_request',
          message: 'operation must be one of mkdir, delete, rename, move',
        });

        const invalidScope = await manage({
          root: 'workspace',
          operation: 'delete',
          path: sentinelName,
        });
        assert.equal(invalidScope.status, 400);
        assert.deepEqual(await invalidScope.json(), {
          code: 'bad_request',
          message: 'root must be computer',
        });

        const deleteRoot = await manage({
          root: 'computer',
          operation: 'delete',
          path: '.',
        });
        assert.equal(deleteRoot.ok, false);
        assert.equal(await fsReadFile(sentinelPath, 'utf8'), 'keep root\n');

        const relocateRoot = await manage({
          root: 'computer',
          operation: 'move',
          path: '.',
          destination: `relocated-${randomUUID()}`,
        });
        assert.equal(relocateRoot.ok, false);
        assert.equal(await fsReadFile(sentinelPath, 'utf8'), 'keep root\n');
      },
      { daemonContext },
    );
  } finally {
    await rm(computerFileRoot, { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route writes a create-only binary file', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-save-binary-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'asset.bin');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const saveRes = await fetch(
          `http://127.0.0.1:${port}/api/files/save-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentBase64: Buffer.from([0x00, 0x01, 0x02, 0xff]).toString(
                'base64',
              ),
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(saveRes.status, 200);
        const body = (await saveRes.json()) as {
          path: string;
          versionToken: string;
          totalLines: number;
          ok: boolean;
        };
        assert.equal(body.ok, true);
        assert.equal(body.path, relativePath);
        assert.equal(body.totalLines, 0);
        assert.deepEqual(
          await fsReadFile(absolutePath),
          Buffer.from([0x00, 0x01, 0x02, 0xff]),
        );
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route saves streamed binary input references beyond the JSON body cap', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-save-binary-ref-${randomUUID()}`;
  const relativePath = `${dirName}/large.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'large.bin');
  const payload = Buffer.alloc(300 * 1024, 0xab);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/octet-stream',
            }),
            body: payload,
          },
        );

        assert.equal(uploadRes.status, 201);
        const uploadBody = (await uploadRes.json()) as {
          ok: boolean;
          contentRef: string;
          byteLength: number;
        };
        assert.equal(uploadBody.ok, true);
        assert.match(uploadBody.contentRef, /^file-binary-input:/u);
        assert.equal(uploadBody.byteLength, payload.byteLength);

        const saveRes = await fetch(
          `http://127.0.0.1:${port}/api/files/save-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentRef: uploadBody.contentRef,
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(saveRes.status, 200);
        const saveBody = (await saveRes.json()) as {
          path: string;
          ok: boolean;
        };
        assert.equal(saveBody.ok, true);
        assert.equal(saveBody.path, relativePath);
        assert.deepEqual(await fsReadFile(absolutePath), payload);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/binary-inputs rejects JSON uploads before creating an empty ref', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ content: 'not a binary stream' }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'binary input upload must use a streaming content type',
    });
  });
});

void test('authenticated files/binary-inputs deletes uploaded binary refs', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: Buffer.from([0x01, 0x02]),
        },
      );
      assert.equal(uploadRes.status, 201);
      const uploadBody = (await uploadRes.json()) as { contentRef: string };

      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer&contentRef=${encodeURIComponent(
          uploadBody.contentRef,
        )}`,
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
      );

      assert.equal(deleteRes.status, 200);
      assert.deepEqual(await deleteRes.json(), { ok: true });
      assert.deepEqual(
        await readFileBinaryInputRefPath({
          workspaceRoot: computerFileRoot,
          contentRef: uploadBody.contentRef,
        }),
        {
          ok: false,
          code: 'not_found',
          message: 'contentRef was not found.',
        },
      );
    },
    { daemonContext },
  );
});

void test('authenticated files/save-binary route rejects overwrite attempts with already_exists', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-save-binary-conflict-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'asset.bin');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, Buffer.from([0x01]));

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const saveRes = await fetch(
          `http://127.0.0.1:${port}/api/files/save-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentBase64: Buffer.from([0x02]).toString('base64'),
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(saveRes.status, 409);
        const body = (await saveRes.json()) as {
          code: string;
          path: string;
        };
        assert.equal(body.code, 'already_exists');
        assert.equal(body.path, relativePath);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route deletes consumed binary refs after save failures', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-save-binary-ref-failure-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'asset.bin');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, Buffer.from([0x01]));

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/octet-stream',
            }),
            body: Buffer.from([0x02]),
          },
        );
        assert.equal(uploadRes.status, 201);
        const uploadBody = (await uploadRes.json()) as {
          contentRef: string;
        };

        const saveRes = await fetch(
          `http://127.0.0.1:${port}/api/files/save-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentRef: uploadBody.contentRef,
            }),
          },
        );

        assert.equal(saveRes.status, 409);
        const resolved = await readFileBinaryInputRefPath({
          workspaceRoot: computerFileRoot,
          contentRef: uploadBody.contentRef,
        });
        assert.deepEqual(resolved, {
          ok: false,
          code: 'not_found',
          message: 'contentRef was not found.',
        });
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route requires exactly one binary content source', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/save-binary`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        root: 'computer',
        path: 'ambiguous-binary.bin',
        contentBase64: Buffer.from([0x00]).toString('base64'),
        contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000000',
      }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'exactly one of contentBase64 or contentRef is required',
    });
  });
});

void test('authenticated files/replace-binary route overwrites an existing binary file', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-replace-binary-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'asset.bin');
  const initial = Buffer.from([0x00, 0x01]);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, initial);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const replaceRes = await fetch(
          `http://127.0.0.1:${port}/api/files/replace-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentBase64: Buffer.from([0x02, 0x03, 0x04]).toString('base64'),
              versionToken: createBinaryVersionToken(initial),
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(replaceRes.status, 200);
        const body = (await replaceRes.json()) as {
          path: string;
          versionToken: string;
          totalLines: number;
          ok: boolean;
        };
        assert.equal(body.ok, true);
        assert.equal(body.path, relativePath);
        assert.equal(body.totalLines, 0);
        assert.equal(typeof body.versionToken, 'string');
        assert.ok(body.versionToken.length > 0);
        assert.deepEqual(
          await fsReadFile(absolutePath),
          Buffer.from([0x02, 0x03, 0x04]),
        );
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/replace-binary route saves streamed binary input references', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-replace-binary-ref-${randomUUID()}`;
  const relativePath = `${dirName}/large.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'large.bin');
  const initial = Buffer.from([0x10, 0x11]);
  const payload = Buffer.alloc(300 * 1024, 0xcd);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, initial);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?root=computer`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/octet-stream',
            }),
            body: payload,
          },
        );

        assert.equal(uploadRes.status, 201);
        const uploadBody = (await uploadRes.json()) as {
          contentRef: string;
          byteLength: number;
        };
        assert.match(uploadBody.contentRef, /^file-binary-input:/u);
        assert.equal(uploadBody.byteLength, payload.byteLength);

        const replaceRes = await fetch(
          `http://127.0.0.1:${port}/api/files/replace-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentRef: uploadBody.contentRef,
              versionToken: createBinaryVersionToken(initial),
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(replaceRes.status, 200);
        const replaceBody = (await replaceRes.json()) as {
          path: string;
          ok: boolean;
        };
        assert.equal(replaceBody.ok, true);
        assert.equal(replaceBody.path, relativePath);
        assert.deepEqual(await fsReadFile(absolutePath), payload);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/replace-binary route surfaces stale conflicts', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const dirName = `route-replace-binary-conflict-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(computerFileRoot, dirName, 'asset.bin');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, Buffer.from([0x00, 0x01]));

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const replaceRes = await fetch(
          `http://127.0.0.1:${port}/api/files/replace-binary`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              root: 'computer',
              path: relativePath,
              contentBase64: Buffer.from([0x02]).toString('base64'),
              versionToken: 'stale-token',
              mimeType: 'application/octet-stream',
            }),
          },
        );

        assert.equal(replaceRes.status, 409);
        const body = (await replaceRes.json()) as {
          code: string;
          path: string;
          currentVersionToken: string;
        };
        assert.equal(body.code, 'conflict_stale_write');
        assert.equal(body.path, relativePath);
        assert.equal(typeof body.currentVersionToken, 'string');
        assert.ok(body.currentVersionToken.length > 0);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route rejects invalid contentBase64 payloads', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/save-binary`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        root: 'computer',
        path: 'invalid-base64.bin',
        contentBase64: 'not-base64',
      }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'contentBase64 must be valid base64',
    });
  });
});

void test('authenticated files/save-binary route rejects non-string mimeType values', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/save-binary`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        root: 'computer',
        path: 'invalid-mime.bin',
        contentBase64: Buffer.from([0x00]).toString('base64'),
        mimeType: 7,
      }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'mimeType must be a string',
    });
  });
});

void test('authenticated files/replace-binary route requires versionToken', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/replace-binary`,
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          root: 'computer',
          path: 'missing-version.bin',
          contentBase64: Buffer.from([0x00]).toString('base64'),
        }),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'versionToken must be a string',
    });
  });
});

void test('authenticated files/read route rejects retired project scope', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/read?projectId=missing-project&path=note.md`,
      {
        headers: authHeaders(),
      },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'projectId is not supported',
    });
  });
});

void test('authenticated files/read route requires the explicit computer root before path validation', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/files/read?path=`, {
      headers: authHeaders(),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      code: 'bad_request',
      message: 'root must be computer',
    });
  });
});
