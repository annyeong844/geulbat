import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import {
  collectSandboxOutputRef,
  isOpaqueSandboxOutputEvidenceRef,
} from './output-validation.js';

void test('collectSandboxOutputRef records files under the output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-sandbox-output-'));
  try {
    const outputDir = join(root, 'out');
    await mkdir(join(outputDir, 'nested'), { recursive: true });
    await writeFile(join(outputDir, 'result.json'), '{}', 'utf8');
    await writeFile(join(outputDir, 'nested', 'log.txt'), 'hello', 'utf8');

    const ref = await collectSandboxOutputRef(outputDir, {
      maxFiles: 4,
      maxBytes: 32,
    });

    assert.equal(ref.rootPath, outputDir);
    assert.equal(ref.totalBytes, 7);
    assert.deepEqual(ref.files.map((file) => file.relativePath).sort(), [
      'nested/log.txt',
      'result.json',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('collectSandboxOutputRef records all files when no budget is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-sandbox-output-'));
  try {
    const outputDir = join(root, 'out');
    await mkdir(outputDir, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(outputDir, `result-${index}.txt`), 'x', 'utf8');
    }

    const ref = await collectSandboxOutputRef(outputDir);

    assert.equal(ref.totalBytes, 12);
    assert.equal(ref.files.length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('collectSandboxOutputRef rejects symlink escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-sandbox-output-'));
  const outside = await mkdtemp(join(tmpdir(), 'geulbat-sandbox-outside-'));
  try {
    const outputDir = join(root, 'out');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    const linked = join(outputDir, 'linked-secret.txt');
    if (!(await createSymlinkOrSkip(t, join(outside, 'secret.txt'), linked))) {
      return;
    }

    await assert.rejects(
      () => collectSandboxOutputRef(outputDir, { maxFiles: 4, maxBytes: 32 }),
      /escapes sandbox output directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test('collectSandboxOutputRef enforces file count and byte budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-sandbox-output-'));
  try {
    const outputDir = join(root, 'out');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'a.txt'), '12345', 'utf8');
    await writeFile(join(outputDir, 'b.txt'), '67890', 'utf8');

    await assert.rejects(
      () => collectSandboxOutputRef(outputDir, { maxFiles: 1, maxBytes: 32 }),
      /too many sandbox output files/,
    );
    await assert.rejects(
      () => collectSandboxOutputRef(outputDir, { maxFiles: 4, maxBytes: 9 }),
      /sandbox output byte budget exceeded/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('isOpaqueSandboxOutputEvidenceRef rejects path-like and malformed refs', () => {
  assert.equal(
    isOpaqueSandboxOutputEvidenceRef('sandbox-output:sandbox-evidence-1'),
    true,
  );

  for (const value of [
    'sandbox-output:',
    'sandbox-output:with space',
    'sandbox-output:with\nnewline',
    'sandbox-output:../escape',
    'sandbox-output:path/segment',
    'sandbox-output:path\\segment',
    'sandbox-output:.geulbat',
    'file:evidence',
    '.geulbat/sandbox-outputs/attempt/candidate.json',
  ]) {
    assert.equal(isOpaqueSandboxOutputEvidenceRef(value), false, value);
  }
});
