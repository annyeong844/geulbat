import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCommandHostWorkerLogPath,
  openWorkerLog,
  WORKER_LOG_MAX_BYTES,
} from './worker-log.js';

async function makeStateRoot(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-worker-log-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  return stateRoot;
}

async function readLines(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

void test('each event is one json line carrying instance identity', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const path = buildCommandHostWorkerLogPath(stateRoot);
  const log = openWorkerLog({ path, workerInstanceId: 'worker-1' });

  log.write('worker_start', { pid: 4242, stateRoot });
  log.write('lock_acquired');
  log.write('recovery', { reapedProcessGroups: 2, skipped: undefined });

  const lines = await readLines(path);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]?.['event'], 'worker_start');
  assert.equal(lines[0]?.['pid'], 4242);
  assert.equal(lines[0]?.['workerInstanceId'], 'worker-1');
  assert.equal(typeof lines[0]?.['ts'], 'string');
  assert.equal(lines[2]?.['reapedProcessGroups'], 2);
  assert.ok(
    !('skipped' in (lines[2] ?? {})),
    'undefined fields do not reach the line',
  );
});

void test('§9.3: the log rotates and stays bounded at two generations', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const path = buildCommandHostWorkerLogPath(stateRoot);
  const log = openWorkerLog({ path, workerInstanceId: 'worker-noisy' });

  const padding = 'x'.repeat(1024);
  for (let i = 0; i < 700; i += 1) {
    log.write('noise', { index: i, padding });
  }

  const current = (await stat(path)).size;
  const previous = (await stat(`${path}.1`)).size;
  assert.ok(
    current <= WORKER_LOG_MAX_BYTES,
    `current generation must stay under the bound, saw ${current}`,
  );
  assert.ok(
    current + previous <= WORKER_LOG_MAX_BYTES * 2,
    'total usage is bounded at two generations',
  );
  // 최신 사건은 항상 현재 세대에 있다.
  const lines = await readLines(path);
  assert.equal(lines.at(-1)?.['index'], 699);
});

void test('a line written immediately before exit still lands on disk', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const path = buildCommandHostWorkerLogPath(stateRoot);
  const script = join(stateRoot, 'crash.mjs');
  const moduleUrl = new URL('./worker-log.js', import.meta.url).href;
  await writeFile(
    script,
    `import { openWorkerLog } from ${JSON.stringify(moduleUrl)};
const log = openWorkerLog({ path: ${JSON.stringify(path)}, workerInstanceId: 'dying' });
log.write('last_words', { reason: 'about to exit' });
process.exit(1);
`,
  );
  await new Promise<void>((resolve) => {
    execFile(process.execPath, [script], () => {
      resolve();
    });
  });

  // 동기 기록이 아니면 이 줄은 사라진다 — 크래시 진단이 통째로 무의미해진다.
  const lines = await readLines(path);
  assert.equal(lines.at(-1)?.['event'], 'last_words');
});

void test('a log that cannot be written never breaks the worker', async (t) => {
  const stateRoot = await makeStateRoot(t);
  // 경로 자리에 디렉터리를 두어 append를 실패시킨다.
  const path = buildCommandHostWorkerLogPath(stateRoot);
  await mkdir(path, { recursive: true });
  const log = openWorkerLog({ path, workerInstanceId: 'worker-blocked' });

  assert.doesNotThrow(() => {
    log.write('worker_start', { pid: 1 });
  });
  assert.equal(log.bytesWritten(), 0);
});
