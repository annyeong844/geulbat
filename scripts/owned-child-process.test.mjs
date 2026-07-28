import { strict as assert } from 'node:assert';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { spawnOwnedChildProcess } from './owned-child-process.mjs';

const temporaryDirectories = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForMarker(path, prematureClose) {
  for (;;) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }

    const closed = await Promise.race([
      prematureClose,
      waitForImmediate().then(() => undefined),
    ]);
    if (closed !== undefined) {
      throw new Error(
        `owned parent closed before its descendant became ready: ${JSON.stringify(closed)}`,
      );
    }
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

void test('owned process termination settles a real descendant tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geulbat-owned-process-'));
  temporaryDirectories.push(directory);
  const marker = join(directory, 'descendant.json');
  const parentScript = join(directory, 'parent.mjs');
  await writeFile(
    parentScript,
    `import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';

const child = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
], { stdio: 'ignore' });
if (typeof child.pid !== 'number') throw new Error('missing descendant pid');
const temporaryMarker = process.argv[2] + '.tmp';
await writeFile(temporaryMarker, JSON.stringify({ pid: child.pid }));
await rename(temporaryMarker, process.argv[2]);
setInterval(() => {}, 1_000);
`,
  );

  const owner = spawnOwnedChildProcess(
    process.execPath,
    [parentScript, marker],
    { cwd: directory, stdio: 'ignore' },
  );
  const close = waitForClose(owner.child);
  let descendantPid;

  try {
    const record = await waitForMarker(marker, close);
    descendantPid = record.pid;
    assert.equal(processExists(owner.child.pid), true);
    assert.equal(processExists(descendantPid), true);

    await owner.terminateTree('SIGTERM');
    await close;
    await owner.settleTree();

    assert.equal(processExists(owner.child.pid), false);
    assert.equal(processExists(descendantPid), false);
  } finally {
    if (processExists(owner.child.pid)) {
      void owner.terminateTree('SIGTERM').catch(() => {
        owner.child.kill('SIGKILL');
      });
    }
    await Promise.allSettled([close, owner.settleTree()]);
    if (typeof descendantPid === 'number' && processExists(descendantPid)) {
      process.kill(descendantPid, 'SIGKILL');
    }
    await access(directory);
  }
});

void test(
  'natural parent exit settles descendants that keep inherited pipes open',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geulbat-owned-pipes-'));
    temporaryDirectories.push(directory);
    const marker = join(directory, 'descendant.json');
    const parentScript = join(directory, 'parent.mjs');
    await writeFile(
      parentScript,
      `import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';

const child = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
], { stdio: ['ignore', 'inherit', 'inherit'] });
if (typeof child.pid !== 'number') throw new Error('missing descendant pid');
child.unref();
const temporaryMarker = process.argv[2] + '.tmp';
await writeFile(temporaryMarker, JSON.stringify({ pid: child.pid }));
await rename(temporaryMarker, process.argv[2]);
`,
    );

    const owner = spawnOwnedChildProcess(
      process.execPath,
      [parentScript, marker],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let descendantPid;

    try {
      const record = await waitForMarker(marker, owner.waitForExit());
      descendantPid = record.pid;
      const exit = await owner.waitForExit();
      assert.equal(exit.code, 0);
      assert.equal(processExists(descendantPid), true);
      assert.equal(
        await Promise.race([
          owner.waitForClose().then(() => true),
          waitForImmediate().then(() => false),
        ]),
        false,
      );

      await owner.settleTree();
      const close = await owner.waitForClose();
      assert.equal(close.code, 0);
      assert.equal(processExists(descendantPid), false);
    } finally {
      await Promise.allSettled([
        owner.terminateTree('SIGTERM'),
        owner.settleTree(),
      ]);
      if (typeof descendantPid === 'number' && processExists(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
      owner.child.stdout.destroy();
      owner.child.stderr.destroy();
    }
  },
);

void test('owned child reports process start failures distinctly', async () => {
  const owner = spawnOwnedChildProcess(
    'geulbat-command-that-does-not-exist-for-owned-child-test',
    [],
    { stdio: 'ignore' },
  );

  const exit = await owner.waitForExit();
  assert.equal(exit.code, 1);
  assert.ok(exit.error instanceof Error);
  assert.equal(exit.error.code, 'ENOENT');
  await owner.settleTree();
  const close = await owner.waitForClose();
  assert.equal(close.code, 1);
  assert.equal(close.error, exit.error);
});
