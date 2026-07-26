import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { spawnGatedChild } from './spawn-gate.js';

// P7.5 §5.1 T12 — "journal에 없는 자식은 존재할 수 없다"의 실행 절반.
// 나머지 절반(open 행이 fdatasync된 뒤에만 GO)은 journal.test.ts가 본다.

async function makeRoot(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-spawn-gate-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function markerArgs(marker: string): string[] {
  return [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  ];
}

void test('T12: the child does not exec until the journal writes GO', async (t) => {
  const root = await makeRoot(t);
  const marker = join(root, 'ran.txt');
  const gated = spawnGatedChild({
    executable: process.execPath,
    args: markerArgs(marker),
    cwd: root,
    env: process.env,
  });
  assert.equal(gated.gated, true, 'POSIX must run the gated wrapper');

  await delay(200);
  assert.equal(
    await pathExists(marker),
    false,
    'the command must not run before GO',
  );

  gated.release();
  await once(gated.child, 'close');
  assert.equal(await pathExists(marker), true);
});

void test('T12: aborting the gate ends the child without ever exec-ing', async (t) => {
  const root = await makeRoot(t);
  const marker = join(root, 'ran.txt');
  const gated = spawnGatedChild({
    executable: process.execPath,
    args: markerArgs(marker),
    cwd: root,
    env: process.env,
  });

  // 워커가 GO 전에 죽은 상황 — 파이프가 닫히고 자식은 exec 없이 끝난다.
  gated.abort();
  const [code] = await once(gated.child, 'close');
  assert.equal(code, 1, 'the wrapper exits non-zero when the gate closes');
  assert.equal(await pathExists(marker), false);
});

void test('the gated child leads its own process group', async (t) => {
  const root = await makeRoot(t);
  const gated = spawnGatedChild({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(String(process.pid))'],
    cwd: root,
    env: process.env,
  });
  gated.release();
  const chunks: Buffer[] = [];
  gated.child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(gated.child, 'close');
  // exec가 pid를 보존하므로 그룹 종료(-pid)가 그대로 유효하다.
  assert.equal(Buffer.concat(chunks).toString('utf8'), String(gated.child.pid));
});
