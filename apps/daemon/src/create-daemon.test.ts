import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PUBLIC_WEB_JSON_ECHO_PATH } from '@geulbat/protocol/public-web-fixtures';

import { createDaemon } from './create-daemon.js';
import { createDaemonContext } from './daemon/context.js';
import { createRouteTestDaemonContext } from './test-support/http-routes.js';

void test('createDaemon starts without MCP when its registry cannot be read', async () => {
  // MCP는 README가 분류한 supporting capability다. 레지스트리 파일이 손상되면
  // 그 내용을 조용히 받아들이지 않는 것(fail-closed)은 옳지만, 그 거부가 부팅
  // 실패로 승격되면 core 워크플로 전체가 서지 못한다. 재시작해도 같은 파일을
  // 다시 읽으므로 감시자와 함께 재시작 루프가 되고, 사용자는 설정 파일 하나
  // 때문에 앱을 열 수 없다.
  //
  // 같은 상황을 provider auth는 이미 이렇게 다룬다: `initProviderAuth`가 로드
  // 실패를 상태로 캐시하고 부팅은 계속된다. MCP도 그 선례를 따른다.
  const daemonContext = createRouteTestDaemonContext();
  const registryPath = join(
    daemonContext.homeStateRoot,
    '.geulbat',
    'mcp-servers.json',
  );
  await mkdir(join(daemonContext.homeStateRoot, '.geulbat'), {
    recursive: true,
  });
  await writeFile(registryPath, '{not-json', 'utf8');

  const daemon = await createDaemon({ daemonContext });
  assert.notEqual(daemon.app, undefined, '데몬은 MCP 없이도 떠야 한다');
});

void test('createDaemon leaves marketplace catalog inspection to the first marketplace request', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await mkdir(daemonContext.homeStateRoot, { recursive: true });
  const marketplaceStore = daemonContext.pluginMarketplaces;
  let initializeCalls = 0;
  daemonContext.pluginMarketplaces = {
    ...marketplaceStore,
    async initialize() {
      initializeCalls += 1;
      await marketplaceStore.initialize();
    },
  };

  const daemon = await createDaemon({ daemonContext });

  assert.notEqual(daemon.app, undefined);
  assert.equal(initializeCalls, 0);
});

void test('createDaemon reaps prior PTC runtime residue before mounting routes', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const observedStateRoots: string[] = [];
  daemonContext.ptc.executeCode.reapRestartResidue = async ({ stateRoot }) => {
    observedStateRoots.push(stateRoot);
    return { ok: true };
  };

  await createDaemon({ daemonContext });

  assert.deepEqual(observedStateRoots, [daemonContext.homeStateRoot]);
});

void test('createDaemon fails closed when prior PTC runtime residue cannot be reaped', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.ptc.executeCode.reapRestartResidue = async () => ({
    ok: false,
    reasonCode: 'ptc_execute_code_session_cleanup_failed',
    message: 'cleanup unavailable',
  });

  await assert.rejects(
    () => createDaemon({ daemonContext }),
    /PTC restart residue cleanup failed during daemon startup/u,
  );
});

void test('createDaemon returns CORS headers for its own origin', async () => {
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
          Origin: `http://127.0.0.1:${port}`,
          'Access-Control-Request-Method': 'GET',
        },
      },
    );

    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      `http://127.0.0.1:${port}`,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'none'/,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /font-src 'self' data:/,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /img-src 'self' blob: data:/,
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), null);
  } finally {
    await closeServer(server);
  }
});

void test('createDaemon rejects other loopback origins on the same machine', async () => {
  // 데몬이 화면까지 서빙하므로 붙어야 할 origin은 자기 자신 하나다. 같은
  // 기계의 다른 포트에서 도는 페이지는 shell이 아니다 — 예전 정책은 loopback
  // 이면 포트를 묻지 않아 그런 페이지까지 함께 열어두었다.
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
          // 데몬이 고른 포트가 무엇이든 이 origin은 아니다.
          Origin: 'http://127.0.0.1:1',
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

void test('createDaemon accepts same-origin cookie authentication when Origin is missing', async () => {
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
          'X-Geulbat-Dev-Token': 'geulbat-test-token-1234',
        },
      });

      assert.equal(res.status, 404);
    }
  } finally {
    await closeServer(server);
    restoreEnv('GEULBAT_DEV_TOKEN', previousToken);
  }
});

void test('createDaemon does not mount public web conformance fixtures by default', async () => {
  const { app } = await createIsolatedDaemon();
  const server = app.listen(0, '127.0.0.1');

  try {
    await onceListening(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_JSON_ECHO_PATH}?message=product-runtime`,
    );

    assert.equal(res.status, 404);
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
    configuredDaemonContext.globalMcp.attachSessionCoordinateStore({
      readMcpSessionCoordinate: () => undefined,
      persistMcpSessionCoordinate: () => undefined,
      deleteMcpSessionCoordinate: () => undefined,
    });
    configuredDaemonContext.ptc.executeCode.reapRestartResidue = async () => ({
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
          'X-Geulbat-Dev-Token': 'geulbat-test-token-1234',
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
  daemonContext.ptc.executeCode.reapRestartResidue = async () => ({ ok: true });
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
