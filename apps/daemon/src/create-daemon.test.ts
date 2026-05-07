import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDaemon } from './create-daemon.js';
import { ProjectRegistryCorruptionError } from './daemon/files/project-store.js';

void test('createDaemon returns loopback CORS headers for allowed preflight origins', async () => {
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://127.0.0.1:5174',
          'Access-Control-Request-Method': 'GET',
        },
      },
    );

    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:5174',
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'none'/,
    );
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon rejects non-loopback preflight origins', async () => {
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'GET',
        },
      },
    );

    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'access_denied');
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon rejects preflight requests when Origin is missing', async () => {
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        method: 'OPTIONS',
        headers: {
          'Access-Control-Request-Method': 'GET',
        },
      },
    );

    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'access_denied');
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon allows explicitly configured external preflight origins', async () => {
  const previous = process.env['GEULBAT_ALLOWED_ORIGINS'];
  process.env['GEULBAT_ALLOWED_ORIGINS'] = 'https://demo.trycloudflare.com';
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://demo.trycloudflare.com',
          'Access-Control-Request-Method': 'GET',
        },
      },
    );

    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'https://demo.trycloudflare.com',
    );
  } finally {
    await closeServer(server);
    restoreEnv('GEULBAT_ALLOWED_ORIGINS', previous);
  }
});

void test('createDaemon allows cookie-authenticated api requests when Origin is missing', async () => {
  const previousToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = 'geulbat-test-token-1234';
  const repoRoot = await mkdtemp(join(tmpdir(), 'geulbat-daemon-cookie-'));
  await mkdir(join(repoRoot, 'workspace'), { recursive: true });
  const { app } = await createDaemon({ repoRoot });
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        headers: {
          Cookie: 'geulbat_dev_auth=geulbat-test-token-1234',
        },
      },
    );

    assert.equal(res.status, 200);
  } finally {
    await closeServer(server);
    await rm(repoRoot, { recursive: true, force: true });
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
  }
});

void test('createDaemon applies auth guard to react bundle inline compile route', async () => {
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/react-bundle-inline-compile`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          renderer: 'react_bundle',
          input: {
            files: {
              'src/App.jsx':
                'export default function App() { return <div>heart</div>; }',
            },
            entry: 'src/App.jsx',
          },
        }),
      },
    );

    assert.equal(res.status, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'unauthorized');
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon rejects malformed GEULBAT_ALLOWED_ORIGINS config', async () => {
  const previous = process.env['GEULBAT_ALLOWED_ORIGINS'];
  process.env['GEULBAT_ALLOWED_ORIGINS'] =
    'https://demo.trycloudflare.com/path';
  try {
    await assert.rejects(
      () => createDaemon(),
      /GEULBAT_ALLOWED_ORIGINS entries must be bare origins/,
    );
  } finally {
    restoreEnv('GEULBAT_ALLOWED_ORIGINS', previous);
  }
});

void test('createDaemon fails fast when project registry metadata is corrupted', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'geulbat-daemon-corrupt-'));
  await mkdir(join(repoRoot, '.geulbat'), { recursive: true });
  await writeFile(
    join(repoRoot, '.geulbat', 'projects.json'),
    '{"version":1,"projects":[',
    'utf8',
  );

  try {
    await assert.rejects(
      () => createDaemon({ repoRoot }),
      (error: unknown) => error instanceof ProjectRegistryCorruptionError,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

void test('createDaemon resolves the default repo root independently of process cwd', async () => {
  const previousCwd = process.cwd();
  const previousToken = process.env['GEULBAT_DEV_TOKEN'];
  const tempCwd = await mkdtemp(join(tmpdir(), 'geulbat-daemon-cwd-'));
  process.env['GEULBAT_DEV_TOKEN'] = 'geulbat-test-token-1234';
  process.chdir(tempCwd);
  const { app } = await createDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?projectId=workspace`,
      {
        headers: {
          Cookie: 'geulbat_dev_auth=geulbat-test-token-1234',
        },
      },
    );

    assert.equal(res.status, 200);
  } finally {
    await closeServer(server);
    process.chdir(previousCwd);
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
    await rm(tempCwd, { recursive: true, force: true });
  }
});

function onceListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
