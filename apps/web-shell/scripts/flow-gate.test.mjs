import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { spawnOwnedChildProcess } from '../../../scripts/owned-child-process.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const flowGatePath = path.join(
  repoRoot,
  'apps',
  'web-shell',
  'scripts',
  'flow-gate.mjs',
);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function waitForValue(readValue, description) {
  const timeoutAt = Date.now() + 30_000;
  let lastError;
  while (Date.now() < timeoutAt) {
    try {
      const value = await readValue();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function startCapturedOwner(command, args, temporaryParent) {
  const temporaryEnvironment =
    process.platform === 'win32'
      ? { TEMP: temporaryParent, TMP: temporaryParent }
      : { TMPDIR: temporaryParent };
  const owner = spawnOwnedChildProcess(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...temporaryEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const appendOutput = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  };
  owner.child.stdout?.on('data', appendOutput);
  owner.child.stderr?.on('data', appendOutput);
  return {
    owner,
    readOutput: () => output,
  };
}

async function waitForInvocationRoot(temporaryParent) {
  return await waitForValue(async () => {
    const entries = await fs.readdir(temporaryParent, {
      withFileTypes: true,
    });
    const entry = entries.find(
      (candidate) =>
        candidate.isDirectory() &&
        candidate.name.startsWith('geulbat-flow-gate-'),
    );
    if (entry === undefined) {
      return undefined;
    }
    const candidateRoot = path.join(temporaryParent, entry.name);
    try {
      await fs.access(
        path.join(
          candidateRoot,
          'home-state',
          '.geulbat',
          'runtime-state.sqlite3',
        ),
      );
      return candidateRoot;
    } catch {
      return undefined;
    }
  }, 'the isolated daemon runtime state');
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function settleTestOwner(owner) {
  const { child } = owner;
  if (process.platform !== 'win32') {
    await owner.terminateTree('SIGKILL').catch(() => {});
    await owner.settleTree().catch(() => {});
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await owner.waitForClose();
  }
}

void test(
  'SIGTERM settles flow-gate children before removing its temporary root',
  { timeout: 45_000 },
  async () => {
    const temporaryParent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'geulbat-flow-gate-signal-test-'),
    );
    const { owner, readOutput } = startCapturedOwner(
      process.execPath,
      [flowGatePath],
      temporaryParent,
    );
    const { child } = owner;

    try {
      const invocationRoot = await waitForInvocationRoot(temporaryParent);

      assert.equal(child.kill('SIGTERM'), true);
      const result = await owner.waitForClose();
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 143, signal: null },
        readOutput(),
      );
      assert.equal(await pathExists(invocationRoot), false, readOutput());
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        assert.equal(processGroupExists(child.pid), false, readOutput());
      }
    } finally {
      await settleTestOwner(owner);
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
  },
);

void test(
  'npm process-group SIGTERM converges after the wrapper exits',
  { skip: process.platform === 'win32', timeout: 45_000 },
  async () => {
    const temporaryParent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'geulbat-flow-gate-npm-signal-test-'),
    );
    const { owner, readOutput } = startCapturedOwner(
      npmCommand,
      ['run', 'gate:flows', '-w', 'apps/web-shell'],
      temporaryParent,
    );
    const { child } = owner;

    try {
      const invocationRoot = await waitForInvocationRoot(temporaryParent);
      assert.equal(typeof child.pid, 'number');
      await owner.terminateTree('SIGTERM');
      await owner.waitForClose();
      await waitForValue(async () => {
        if (
          !(await pathExists(invocationRoot)) &&
          !processGroupExists(child.pid)
        ) {
          return true;
        }
        return undefined;
      }, 'npm-descendant cleanup after process-group SIGTERM').catch(
        (error) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${readOutput()}`,
          );
        },
      );
    } finally {
      await settleTestOwner(owner);
      await fs.rm(temporaryParent, { recursive: true, force: true });
    }
  },
);
