import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';

import { createDaemon } from '../create-daemon.js';
import { createDaemonContext, type DaemonContext } from '../daemon/context.js';
import { ensureTestProviderAuthFilePath } from './provider-auth.js';

const DEV_TOKEN = 'geulbat-test-token-1234';
ensureTestProviderAuthFilePath();

export function createRouteTestDaemonContext(): DaemonContext {
  const testRoot = createRouteTestRoot();
  const homeStateRoot = join(testRoot, 'home');
  const computerFileRoot = join(testRoot, 'computer');
  const daemonContext = createDaemonContext({ homeStateRoot });
  daemonContext.computerFileScope = {
    root: computerFileRoot,
    browseShortcuts: [],
  };
  daemonContext.computerFileRoot = computerFileRoot;
  return daemonContext;
}

export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [DEV_TOKEN_HEADER_NAME]: DEV_TOKEN,
    ...extra,
  };
}

export function getHomeStateRootFromContext(
  daemonContext: Pick<DaemonContext, 'homeStateRoot'>,
): string {
  return daemonContext.homeStateRoot;
}

export function getComputerFileRootFromContext(
  daemonContext: Pick<DaemonContext, 'computerFileRoot'>,
): string {
  assert.ok(
    daemonContext.computerFileRoot,
    'computer file root must be configured',
  );
  return daemonContext.computerFileRoot;
}

export async function withAuthenticatedDaemonServer<T>(
  run: (ctx: { port: number; daemonContext: DaemonContext }) => Promise<T>,
  args?: { daemonContext?: DaemonContext },
): Promise<T> {
  const restoreToken = setDevToken();
  try {
    return await withDaemonServer(run, args);
  } finally {
    restoreToken();
  }
}

export async function withDaemonServer<T>(
  run: (ctx: { port: number; daemonContext: DaemonContext }) => Promise<T>,
  args?: { daemonContext?: DaemonContext },
): Promise<T> {
  const daemonContext = args?.daemonContext ?? createRouteTestDaemonContext();
  await ensureRouteTestRoots(daemonContext);
  const { app } = await createDaemon({ daemonContext });
  const server = app.listen(0, '127.0.0.1');

  try {
    return await run({
      port: await listenPort(server),
      daemonContext,
    });
  } finally {
    try {
      await closeServer(server);
    } finally {
      await daemonContext.providerAuthCallbackServer.close();
    }
  }
}

function setDevToken(): () => void {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = DEV_TOKEN;
  return () => restoreEnv('GEULBAT_DEV_TOKEN', previous);
}

function createRouteTestRoot(): string {
  return join(tmpdir(), `geulbat-route-test-${randomUUID()}`);
}

async function ensureRouteTestRoots(
  daemonContext: Pick<DaemonContext, 'computerFileRoot' | 'homeStateRoot'>,
): Promise<void> {
  await Promise.all([
    mkdir(daemonContext.homeStateRoot, { recursive: true }),
    mkdir(getComputerFileRootFromContext(daemonContext), { recursive: true }),
  ]);
}

async function listenPort(server: Server): Promise<number> {
  await onceListening(server);
  return (server.address() as AddressInfo).port;
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
