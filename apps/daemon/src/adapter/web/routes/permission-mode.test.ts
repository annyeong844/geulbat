import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { resolvePermissionModeFilePath } from '../../../daemon/permission-mode-store.js';
import { createPermissionModeRoutes } from './permission-mode.js';

interface RouteHarness {
  baseUrl: string;
  homeStateRoot: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<RouteHarness> {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'permission-mode-route-'));
  const app = express();
  app.use(express.json());
  app.use(createPermissionModeRoutes({ homeStateRoot }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    homeStateRoot,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(homeStateRoot, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  run: (harness: RouteHarness) => Promise<void>,
): Promise<void> {
  const harness = await startHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

void test('the route reports the safe default before any mode has been stored', async () => {
  await withHarness(async (harness) => {
    const response = await fetch(`${harness.baseUrl}/api/permission-mode`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      permissionMode: 'basic',
      updatedAt: null,
    });
  });
});

void test('a stored mode is visible to a later reader, which is what a reload sees', async () => {
  await withHarness(async (harness) => {
    const put = await fetch(`${harness.baseUrl}/api/permission-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'full_access' }),
    });
    assert.equal(put.status, 200);

    const reloaded = await fetch(`${harness.baseUrl}/api/permission-mode`);
    const body = (await reloaded.json()) as Record<string, unknown>;
    assert.equal(body['permissionMode'], 'full_access');
    assert.equal(typeof body['updatedAt'], 'string');
  });
});

void test('an unknown mode is refused so the stored value cannot be widened past the known set', async () => {
  await withHarness(async (harness) => {
    const response = await fetch(`${harness.baseUrl}/api/permission-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'unrestricted' }),
    });
    assert.equal(response.status, 400);

    const after = await fetch(`${harness.baseUrl}/api/permission-mode`);
    assert.deepEqual(await after.json(), {
      permissionMode: 'basic',
      updatedAt: null,
    });
  });
});

void test('an unrelated body field is refused instead of being silently dropped', async () => {
  await withHarness(async (harness) => {
    const response = await fetch(`${harness.baseUrl}/api/permission-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'basic', grantScope: 'session' }),
    });
    assert.equal(response.status, 400);
  });
});

void test('a corrupt stored document is reported with the safe mode instead of being overwritten', async () => {
  await withHarness(async (harness) => {
    const filePath = resolvePermissionModeFilePath(harness.homeStateRoot);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken', 'utf-8');

    const response = await fetch(`${harness.baseUrl}/api/permission-mode`);
    assert.equal(response.status, 500);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['permissionMode'], 'basic');
    assert.match(String(body['message']), /permission-mode\.json/);
  });
});
