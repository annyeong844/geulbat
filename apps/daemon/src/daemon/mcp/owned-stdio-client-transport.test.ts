import assert from 'node:assert/strict';
import test from 'node:test';

import { OwnedStdioClientTransport } from './owned-stdio-client-transport.js';

const TEST_SHUTDOWN_GRACE_MS = 50;
const TEST_PROCESS_SETTLEMENT_TIMEOUT_MS = 2_000;

interface SpawnedTree {
  leaderPid: number;
  descendantPid: number;
}

void test(
  'owned MCP stdio transport force-settles its POSIX leader and descendant',
  { skip: process.platform === 'win32' },
  async () => {
    const transport = createTransport(createPersistentTreeSource());
    const treePromise = readSpawnedTree(transport);
    let tree: SpawnedTree | undefined;
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };

    try {
      await transport.start();
      tree = await treePromise;
      assert.equal(transport.pid, tree.leaderPid);
      assert.equal(isProcessAlive(tree.leaderPid), true);
      assert.equal(isProcessAlive(tree.descendantPid), true);

      await Promise.all([transport.close(), transport.close()]);

      await assertProcessesGone(tree);
      assert.equal(transport.pid, null);
      assert.equal(closeCount, 1);
      await assert.rejects(transport.start(), /can only be started once/u);
    } finally {
      await transport.close().catch(() => undefined);
      forceCleanup(tree);
    }
  },
);

void test(
  'owned MCP stdio transport sweeps a surviving descendant after unexpected leader exit',
  { skip: process.platform === 'win32' },
  async () => {
    const transport = createTransport(createUnexpectedExitTreeSource());
    const treePromise = readSpawnedTree(transport);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    let tree: SpawnedTree | undefined;

    try {
      await transport.start();
      tree = await treePromise;
      assert.equal(isProcessAlive(tree.descendantPid), true);

      await closed;

      await assertProcessesGone(tree);
      assert.equal(transport.pid, null);
    } finally {
      await transport.close().catch(() => undefined);
      forceCleanup(tree);
    }
  },
);

function createTransport(source: string): OwnedStdioClientTransport {
  return new OwnedStdioClientTransport({
    command: process.execPath,
    args: ['-e', source],
    env: {},
    shutdownGraceMs: TEST_SHUTDOWN_GRACE_MS,
  });
}

function readSpawnedTree(
  transport: OwnedStdioClientTransport,
): Promise<SpawnedTree> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const newlineIndex = stderr.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      transport.stderr.off('data', onData);
      try {
        const value = JSON.parse(stderr.slice(0, newlineIndex)) as unknown;
        if (
          !isRecord(value) ||
          !Number.isSafeInteger(value['leaderPid']) ||
          !Number.isSafeInteger(value['descendantPid'])
        ) {
          reject(new Error('test process tree reported an invalid pid pair'));
          return;
        }
        resolve({
          leaderPid: value['leaderPid'] as number,
          descendantPid: value['descendantPid'] as number,
        });
      } catch (error: unknown) {
        reject(error);
      }
    };
    transport.stderr.on('data', onData);
  });
}

async function assertProcessesGone(tree: SpawnedTree): Promise<void> {
  const deadline = Date.now() + TEST_PROCESS_SETTLEMENT_TIMEOUT_MS;
  while (isProcessAlive(tree.leaderPid) || isProcessAlive(tree.descendantPid)) {
    if (Date.now() >= deadline) {
      assert.fail(
        `process tree remained alive: leader=${tree.leaderPid}, descendant=${tree.descendantPid}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function forceCleanup(tree: SpawnedTree | undefined): void {
  if (!tree || process.platform === 'win32') {
    return;
  }
  try {
    process.kill(-tree.leaderPid, 'SIGKILL');
  } catch (error: unknown) {
    if (!isErrorWithCode(error, 'ESRCH')) {
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isErrorWithCode(error, 'ESRCH')) {
      return false;
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createPersistentTreeSource(): string {
  return `
    const { spawn } = require('node:child_process');
    const descendantSource = \`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1_000);
    \`;
    const descendant = spawn(process.execPath, ['-e', descendantSource], {
      stdio: 'ignore',
    });
    process.on('SIGTERM', () => {});
    process.stderr.write(JSON.stringify({
      leaderPid: process.pid,
      descendantPid: descendant.pid,
    }) + '\\n');
    setInterval(() => {}, 1_000);
  `;
}

function createUnexpectedExitTreeSource(): string {
  return `
    const { spawn } = require('node:child_process');
    const descendantSource = \`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1_000);
    \`;
    const descendant = spawn(process.execPath, ['-e', descendantSource], {
      stdio: 'ignore',
    });
    process.stderr.write(JSON.stringify({
      leaderPid: process.pid,
      descendantPid: descendant.pid,
    }) + '\\n');
    setTimeout(() => process.exit(0), 75);
  `;
}
