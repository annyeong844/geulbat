import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildSourceSnapshot } from './source-snapshot.js';

void test('buildSourceSnapshot excludes reserved roots through filePlatform enumeration', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-source-snap-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await mkdir(join(workspaceRoot, '.git'), { recursive: true });
  await mkdir(join(workspaceRoot, '.geulbat', 'tool-state'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'src', 'app.ts'),
    'export const ok = 1;\n',
  );
  await writeFile(join(workspaceRoot, '.git', 'config'), '[core]\n');
  await writeFile(
    join(workspaceRoot, '.geulbat', 'tool-state', 'state.json'),
    '{"ok":true}\n',
  );

  const snapshot = await buildSourceSnapshot(workspaceRoot);

  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['src/app.ts'],
  );
});

void test('buildSourceSnapshot includes large text files instead of silently skipping them', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-source-snap-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  const content = Array.from(
    { length: 20_050 },
    (_, index) => `memory line ${index + 1}`,
  ).join('\n');
  await writeFile(join(workspaceRoot, 'docs', 'large.md'), `${content}\n`);

  const snapshot = await buildSourceSnapshot(workspaceRoot);

  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['docs/large.md'],
  );
  assert.equal(snapshot.files[0]?.lines.length, 20_050);
});
