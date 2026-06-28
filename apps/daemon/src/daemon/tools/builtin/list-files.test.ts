import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listFilesTool } from './list-files.js';

void test('list_files defaults a missing path to workspace root', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));
  await mkdir(join(workspaceRoot, 'src'));
  await writeFile(join(workspaceRoot, 'src', 'hello.txt'), 'hello\n', 'utf8');

  const result = await listFilesTool.execute(
    {},
    { callId: 'call-list-1', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    path: string;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.path, '.');
  assert.ok(payload.entries.some((entry) => entry.path === 'src'));
});

void test('list_files rejects an empty path instead of treating it as root', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));

  const result = await listFilesTool.execute(
    { path: '' },
    { callId: 'call-list-2', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path:/);
});

void test('list_files rejects blank path at the parser boundary', async () => {
  const result = await listFilesTool.execute(
    { path: '   ' },
    { callId: 'call-list-blank-path', workspaceRoot: '/workspace/project' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('list_files returns entries beyond the old fixed cap', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));
  const fileCount = 520;
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(workspaceRoot, `entry-${String(index).padStart(3, '0')}.txt`),
        'listed\n',
        'utf8',
      ),
    ),
  );

  const result = await listFilesTool.execute(
    {},
    { callId: 'call-list-many', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.total, fileCount);
  assert.equal(payload.entries.length, fileCount);
  assert.equal(
    payload.entries.some((entry) => entry.path === 'entry-519.txt'),
    true,
  );
  assert.equal(Object.hasOwn(payload, 'truncated'), false);
});
