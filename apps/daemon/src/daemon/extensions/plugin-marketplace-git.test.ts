import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMarketplaceFixture,
  runGit,
  runMarketplaceTestCommand,
} from '../../test-support/plugin-marketplace-store-test-support.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';
import { acquirePluginMarketplaceGitRepository } from './plugin-marketplace-git.js';

void test('real Git acquisition resolves a detached local revision without repository hooks', async () => {
  const fixture = await createMarketplaceFixture();
  const checkoutRoot = join(fixture.root, 'checkout');
  try {
    await acquirePluginMarketplaceGitRepository({
      repositoryRoot: checkoutRoot,
      url: fixture.repositoryRoot,
      requestedRef: null,
      isolatedConfigRoot: join(fixture.root, 'git-runtime'),
      runCommand: runMarketplaceTestCommand,
    });
    assert.equal(
      await readFile(
        join(checkoutRoot, '.agents', 'plugins', 'marketplace.json'),
        'utf8',
      ).then((value) => value.includes('fixture-marketplace')),
      true,
    );
    assert.equal(
      runGit(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      'HEAD',
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('Git acquisition fails closed without a daemon host command runner', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'geulbat-marketplace-unrouted-git-'),
  );
  try {
    await assert.rejects(
      acquirePluginMarketplaceGitRepository({
        repositoryRoot: join(root, 'checkout'),
        url: 'https://github.com/example/plugins.git',
        requestedRef: null,
        isolatedConfigRoot: join(root, 'git-runtime'),
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request' &&
        /requires the daemon host command runtime/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
