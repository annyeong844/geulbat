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

import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import { createBinaryVersionToken } from './daemon/files/version-token.js';
import { readFileBinaryInputRefPath } from './daemon/files/binary-input-ref-store.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getSecondaryProjectIdFromContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('authenticated files/read route returns file contents', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-read-${randomUUID()}`;
  const relativePath = `${dirName}/note.md`;
  const absolutePath = join(workspaceRoot, dirName, 'note.md');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, '# route read\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/files/read?projectId=${DEFAULT_PROJECT_ID}&path=${encodeURIComponent(relativePath)}`,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/tree route resolves secondary project roots', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const secondaryProjectId = getSecondaryProjectIdFromContext(daemonContext);
  const secondaryRoot = getWorkspaceRootFromContext(
    daemonContext,
    secondaryProjectId,
  );
  const relativePath = `route-tree-${randomUUID()}.md`;
  const absolutePath = join(secondaryRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, '# route tree\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/files/tree?projectId=${secondaryProjectId}`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          projectId: string;
          tree: Array<{ path: string; type: string }>;
        };
        assert.equal(body.projectId, secondaryProjectId);
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
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const relativePath = `route-save-create-${randomUUID()}.md`;
  const absolutePath = join(workspaceRoot, relativePath);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const saveRes = await fetch(`http://127.0.0.1:${port}/api/files/save`, {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            projectId: DEFAULT_PROJECT_ID,
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
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-save-${randomUUID()}`;
  const relativePath = `${dirName}/draft.md`;
  const absolutePath = join(workspaceRoot, dirName, 'draft.md');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, 'first\n', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const readRes = await fetch(
          `http://127.0.0.1:${port}/api/files/read?projectId=${DEFAULT_PROJECT_ID}&path=${encodeURIComponent(relativePath)}`,
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
            projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route writes a create-only binary file', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-save-binary-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'asset.bin');

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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route saves streamed binary input references beyond the JSON body cap', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-save-binary-ref-${randomUUID()}`;
  const relativePath = `${dirName}/large.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'large.bin');
  const payload = Buffer.alloc(300 * 1024, 0xab);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}`,
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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/binary-inputs rejects JSON uploads before creating an empty ref', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}`,
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
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}`,
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
        `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}&contentRef=${encodeURIComponent(
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
          workspaceRoot,
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
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-save-binary-conflict-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'asset.bin');

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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/save-binary route deletes consumed binary refs after save failures', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-save-binary-ref-failure-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'asset.bin');

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, Buffer.from([0x01]));

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}`,
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
              projectId: DEFAULT_PROJECT_ID,
              path: relativePath,
              contentRef: uploadBody.contentRef,
            }),
          },
        );

        assert.equal(saveRes.status, 409);
        const resolved = await readFileBinaryInputRefPath({
          workspaceRoot,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
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
        projectId: DEFAULT_PROJECT_ID,
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
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-replace-binary-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'asset.bin');
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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/replace-binary route saves streamed binary input references', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-replace-binary-ref-${randomUUID()}`;
  const relativePath = `${dirName}/large.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'large.bin');
  const initial = Buffer.from([0x10, 0x11]);
  const payload = Buffer.alloc(300 * 1024, 0xcd);

  await mkdir(dirname(absolutePath), { recursive: true });
  await fsWriteFile(absolutePath, initial);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const uploadRes = await fetch(
          `http://127.0.0.1:${port}/api/files/binary-inputs?projectId=${DEFAULT_PROJECT_ID}`,
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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
  }
});

void test('authenticated files/replace-binary route surfaces stale conflicts', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const workspaceRoot = getWorkspaceRootFromContext(daemonContext);
  const dirName = `route-replace-binary-conflict-${randomUUID()}`;
  const relativePath = `${dirName}/asset.bin`;
  const absolutePath = join(workspaceRoot, dirName, 'asset.bin');

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
              projectId: DEFAULT_PROJECT_ID,
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
    await rm(join(workspaceRoot, dirName), { recursive: true, force: true });
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
        projectId: DEFAULT_PROJECT_ID,
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
        projectId: DEFAULT_PROJECT_ID,
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
          projectId: DEFAULT_PROJECT_ID,
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

void test('authenticated files/read route preserves unknown project failure shape', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/read?projectId=missing-project&path=note.md`,
      {
        headers: authHeaders(),
      },
    );

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      code: 'not_found',
      message: 'unknown projectId: missing-project',
    });
  });
});

void test('authenticated files/read route keeps the first validation error when project and path are both invalid', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/read?projectId=missing-project&path=`,
      {
        headers: authHeaders(),
      },
    );

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      code: 'not_found',
      message: 'unknown projectId: missing-project',
    });
  });
});
