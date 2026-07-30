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
import {
  authHeaders,
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

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

void test('authenticated files/manage route rejects invalid operation shapes', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const sentinelName = `route-manage-root-${randomUUID()}.txt`;

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
    },
    { daemonContext },
  );
});
