import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';
import {
  inventoryPackageTree,
  readJsonObject,
} from './plugin-package-secure-fs.js';

void test('plugin JSON syntax failures retain their parser cause', async () => {
  const packageRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-plugin-json-syntax-'),
  );
  const manifestPath = join(packageRoot, 'plugin.json');

  try {
    await writeFile(manifestPath, '{', 'utf8');
    const entries = await inventoryPackageTree(packageRoot);
    const manifestEntry = entries.get('plugin.json');
    assert.ok(manifestEntry);

    await assert.rejects(
      readJsonObject(manifestPath, 'plugin.json', manifestEntry),
      (error: unknown) => {
        assert.ok(error instanceof PluginPackageAdmissionError);
        assert.equal(error.message, 'plugin JSON is invalid: plugin.json');
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

void test('plugin JSON read failures are not reported as syntax failures', async () => {
  const packageRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-plugin-json-read-'),
  );
  const manifestPath = join(packageRoot, 'plugin.json');

  try {
    await writeFile(manifestPath, '{}', 'utf8');
    const entries = await inventoryPackageTree(packageRoot);
    const manifestEntry = entries.get('plugin.json');
    assert.ok(manifestEntry);
    await unlink(manifestPath);

    await assert.rejects(
      readJsonObject(manifestPath, 'plugin.json', manifestEntry),
      (error: unknown) => {
        assert.ok(error instanceof PluginPackageAdmissionError);
        assert.equal(
          error.message,
          'plugin JSON could not be read: plugin.json',
        );
        assert.equal(
          (error.cause as NodeJS.ErrnoException | undefined)?.code,
          'ENOENT',
        );
        return true;
      },
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
