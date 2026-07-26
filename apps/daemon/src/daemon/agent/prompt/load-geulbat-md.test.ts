import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGeulbatInstructions } from './load-geulbat-md.js';
import { buildSystemPrompt } from './build-system-prompt.js';

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-md-'));
}

void test('geulbat.md is collected from the project root down to the working directory', async () => {
  const root = await makeWorkspace();
  const nested = join(root, 'apps', 'writing');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, 'geulbat.md'), '루트 지침', 'utf8');
  await writeFile(join(root, 'apps', 'geulbat.md'), '중간 지침', 'utf8');
  await writeFile(join(nested, 'geulbat.md'), '가장 가까운 지침', 'utf8');

  const loaded = await loadGeulbatInstructions(nested);

  assert.deepEqual(loaded.sources, [
    join(root, 'geulbat.md'),
    join(root, 'apps', 'geulbat.md'),
    join(nested, 'geulbat.md'),
  ]);
  assert.equal(
    loaded.instructions,
    '루트 지침\n\n중간 지침\n\n가장 가까운 지침',
  );
});

void test('discovery stops at the project root and never walks above it', async () => {
  const outer = await makeWorkspace();
  const root = join(outer, 'workspace');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(outer, 'geulbat.md'), '루트 밖 지침', 'utf8');
  await writeFile(join(root, 'geulbat.md'), '루트 지침', 'utf8');

  const loaded = await loadGeulbatInstructions(root);

  assert.deepEqual(loaded.sources, [join(root, 'geulbat.md')]);
  assert.equal(loaded.instructions, '루트 지침');
});

void test('a directory without a root marker reads only its own geulbat.md', async () => {
  const outer = await makeWorkspace();
  const nested = join(outer, 'a', 'b');
  await mkdir(nested, { recursive: true });
  await writeFile(join(outer, 'geulbat.md'), '조상 지침', 'utf8');
  await writeFile(join(nested, 'geulbat.md'), '현재 폴더 지침', 'utf8');

  const loaded = await loadGeulbatInstructions(nested);

  assert.deepEqual(loaded.sources, [join(nested, 'geulbat.md')]);
});

void test('geulbat.local.md overrides the committed file in the same directory', async () => {
  const root = await makeWorkspace();
  await writeFile(join(root, 'geulbat.md'), '커밋된 지침', 'utf8');
  await writeFile(join(root, 'geulbat.local.md'), '로컬 재정의', 'utf8');

  const loaded = await loadGeulbatInstructions(root);

  assert.deepEqual(loaded.sources, [join(root, 'geulbat.local.md')]);
  assert.equal(loaded.instructions, '로컬 재정의');
});

void test('a linked worktree root is found when .git is a file, not a directory', async () => {
  const outer = await makeWorkspace();
  const root = join(outer, 'checkout');
  const nested = join(root, 'apps');
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(root, '.git'),
    'gitdir: /somewhere/else/.git/worktrees/checkout\n',
    'utf8',
  );
  await writeFile(join(outer, 'geulbat.md'), '루트 밖 지침', 'utf8');
  await writeFile(join(root, 'geulbat.md'), '루트 지침', 'utf8');
  await writeFile(join(nested, 'geulbat.md'), '하위 지침', 'utf8');

  const loaded = await loadGeulbatInstructions(nested);

  assert.deepEqual(loaded.sources, [
    join(root, 'geulbat.md'),
    join(nested, 'geulbat.md'),
  ]);
  assert.equal(loaded.instructions, '루트 지침\n\n하위 지침');
});

void test('an unusable local override does not fall back to the committed file', async () => {
  const root = await makeWorkspace();
  await writeFile(join(root, 'geulbat.md'), '커밋된 지침', 'utf8');
  await writeFile(
    join(root, 'geulbat.local.md'),
    'x'.repeat(64 * 1024 + 1),
    'utf8',
  );

  const loaded = await loadGeulbatInstructions(root);

  assert.deepEqual(loaded.sources, []);
  assert.equal(loaded.instructions, undefined);
});

void test('the nearest instructions win the shared byte budget when the chain does not fit', async () => {
  const root = await makeWorkspace();
  const nested = join(root, 'apps');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, 'geulbat.md'), 'r'.repeat(40 * 1024), 'utf8');
  await writeFile(join(nested, 'geulbat.md'), 'n'.repeat(40 * 1024), 'utf8');

  const loaded = await loadGeulbatInstructions(nested);

  assert.deepEqual(loaded.sources, [join(nested, 'geulbat.md')]);
  assert.equal(loaded.instructions, 'n'.repeat(40 * 1024));
});

void test('missing, empty, and oversized instruction files leave the prompt unchanged', async () => {
  const missing = await loadGeulbatInstructions(await makeWorkspace());
  assert.equal(missing.instructions, undefined);

  const emptyRoot = await makeWorkspace();
  await writeFile(join(emptyRoot, 'geulbat.md'), '   \n\n', 'utf8');
  assert.equal(
    (await loadGeulbatInstructions(emptyRoot)).instructions,
    undefined,
  );

  const hugeRoot = await makeWorkspace();
  await writeFile(
    join(hugeRoot, 'geulbat.md'),
    'x'.repeat(64 * 1024 + 1),
    'utf8',
  );
  assert.equal(
    (await loadGeulbatInstructions(hugeRoot)).instructions,
    undefined,
  );

  assert.equal(
    (await loadGeulbatInstructions(undefined)).instructions,
    undefined,
  );
  assert.equal(
    (await loadGeulbatInstructions('relative/path')).instructions,
    undefined,
  );
});

void test('project instructions enter the prompt as guidance, not as tool authority', () => {
  const withInstructions = buildSystemPrompt({
    profile: 'root',
    computerSessionAvailable: false,
    projectInstructions: '한국어로 답하고 존댓말을 쓴다',
  });

  assert.match(withInstructions, /<project-instructions>/u);
  assert.match(withInstructions, /한국어로 답하고 존댓말을 쓴다/u);
  assert.match(withInstructions, /does not grant tool authority/u);

  const withoutInstructions = buildSystemPrompt({
    profile: 'root',
    computerSessionAvailable: false,
  });
  assert.equal(withoutInstructions.includes('<project-instructions>'), false);
});
