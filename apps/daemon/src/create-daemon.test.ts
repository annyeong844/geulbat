import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDaemon } from './create-daemon.js';
import { createDaemonContext } from './daemon/context.js';
import { createRouteTestDaemonContext } from './test-support/http-routes.js';

void test('createDaemon reaps prior PTC runtime residue before mounting routes', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const observedStateRoots: string[] = [];
  daemonContext.ptcExecuteCode.reapRestartResidue = async ({ stateRoot }) => {
    observedStateRoots.push(stateRoot);
    return { ok: true };
  };

  await createDaemon({ daemonContext });

  assert.deepEqual(observedStateRoots, [daemonContext.homeStateRoot]);
});

void test('createDaemon fails closed when prior PTC runtime residue cannot be reaped', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.ptcExecuteCode.reapRestartResidue = async () => ({
    ok: false,
    reasonCode: 'ptc_execute_code_session_cleanup_failed',
    message: 'cleanup unavailable',
  });

  await assert.rejects(
    () => createDaemon({ daemonContext }),
    /PTC restart residue cleanup failed during daemon startup/u,
  );
});

void test('createDaemon returns loopback CORS headers for allowed preflight origins', async () => {
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?root=computer`,
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
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), null);
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon rejects non-loopback preflight origins', async () => {
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?root=computer`,
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
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?root=computer`,
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
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?root=computer`,
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
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/computer-scope`,
      {
        headers: {
          Cookie: 'geulbat_dev_auth=geulbat-test-token-1234',
        },
      },
    );

    assert.equal(res.status, 200);
  } finally {
    await closeServer(server);
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
  }
});

void test('createDaemon applies auth guard to react bundle inline compile route', async () => {
  const { app } = await createIsolatedDaemon();
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

void test('createDaemon does not mount shared browser routes', async () => {
  const previousToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = 'geulbat-test-token-1234';
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    for (const path of ['/api/browser/share', '/api/browser/live-session']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          Cookie: 'geulbat_dev_auth=geulbat-test-token-1234',
        },
      });

      assert.equal(res.status, 404);
    }
  } finally {
    await closeServer(server);
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
  }
});

void test('createDaemon rejects malformed GEULBAT_ALLOWED_ORIGINS config', async () => {
  const previous = process.env['GEULBAT_ALLOWED_ORIGINS'];
  process.env['GEULBAT_ALLOWED_ORIGINS'] =
    'https://demo.trycloudflare.com/path';
  try {
    await assert.rejects(
      () => createIsolatedDaemon(),
      /GEULBAT_ALLOWED_ORIGINS entries must be bare origins/,
    );
  } finally {
    restoreEnv('GEULBAT_ALLOWED_ORIGINS', previous);
  }
});

void test('createDaemon resolves the configured Home state root independently of process cwd', async () => {
  const previousCwd = process.cwd();
  const previousToken = process.env['GEULBAT_DEV_TOKEN'];
  const previousHomeStateRoot = process.env['GEULBAT_HOME_STATE_ROOT'];
  const tempCwd = await mkdtemp(join(tmpdir(), 'geulbat-daemon-cwd-'));
  const expectedHomeStateRoot = join(tempCwd, 'home-state');
  process.env['GEULBAT_DEV_TOKEN'] = 'geulbat-test-token-1234';
  process.env['GEULBAT_HOME_STATE_ROOT'] = expectedHomeStateRoot;
  let server: Server | undefined;

  try {
    process.chdir(tempCwd);
    const configuredDaemonContext = createDaemonContext();
    configuredDaemonContext.ptcExecuteCode.reapRestartResidue = async () => ({
      ok: true,
    });
    const { app, daemonContext } = await createDaemon({
      daemonContext: configuredDaemonContext,
    });
    assert.equal(daemonContext.homeStateRoot, expectedHomeStateRoot);
    server = app.listen(0, '127.0.0.1');
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/computer-scope`,
      {
        headers: {
          Cookie: 'geulbat_dev_auth=geulbat-test-token-1234',
        },
      },
    );

    assert.equal(res.status, 200);
  } finally {
    if (server !== undefined) {
      await closeServer(server);
    }
    process.chdir(previousCwd);
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
    restoreEnv('GEULBAT_HOME_STATE_ROOT', previousHomeStateRoot);
    await rm(tempCwd, { recursive: true, force: true });
  }
});

function createIsolatedDaemon() {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.ptcExecuteCode.reapRestartResidue = async () => ({ ok: true });
  return createDaemon({ daemonContext });
}

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
