import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

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

void test('files/tree depth 1 reads only the requested directory level', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerFileRoot = getComputerFileRootFromContext(daemonContext);
  const relativeRoot = `route-tree-lazy-${randomUUID()}`;
  const nestedDirectory = join(
    computerFileRoot,
    relativeRoot,
    'child-directory',
  );

  await mkdir(nestedDirectory, { recursive: true });
  await fsWriteFile(
    join(computerFileRoot, relativeRoot, 'direct.txt'),
    'direct\n',
    'utf8',
  );
  await fsWriteFile(
    join(nestedDirectory, 'grandchild.txt'),
    'nested\n',
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/files/tree?root=computer&path=${encodeURIComponent(relativeRoot)}&depth=1`,
          { headers: authHeaders() },
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          tree: Array<{
            path: string;
            type: string;
            children?: unknown[];
          }>;
        };
        assert.deepEqual(body.tree, [
          {
            name: 'child-directory',
            path: `${relativeRoot}/child-directory`,
            type: 'directory',
          },
          {
            name: 'direct.txt',
            path: `${relativeRoot}/direct.txt`,
            type: 'file',
          },
        ]);
      },
      { daemonContext },
    );
  } finally {
    await rm(join(computerFileRoot, relativeRoot), {
      recursive: true,
      force: true,
    });
  }
});
