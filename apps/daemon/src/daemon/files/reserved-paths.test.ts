import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getExcludedContentSearchGlobs,
  isReservedPath,
  shouldExcludeWorkspaceEntry,
} from './reserved-paths.js';

void test('isReservedPath blocks expanded env and package manager dotfiles', () => {
  assert.equal(isReservedPath('.envrc'), true);
  assert.equal(isReservedPath('.npmrc'), true);
  assert.equal(isReservedPath('.yarnrc.yml'), true);
  assert.equal(isReservedPath('.GIT/config'), true);
  assert.equal(isReservedPath('.Env'), true);
});

void test('isReservedPath does not over-block unrelated filenames', () => {
  assert.equal(isReservedPath('.environment'), false);
  assert.equal(isReservedPath('docs/.env-guide.md'), false);
});

void test('shouldExcludeWorkspaceEntry covers search/list directory skips', () => {
  assert.equal(shouldExcludeWorkspaceEntry('.geulbat', '.geulbat'), true);
  assert.equal(shouldExcludeWorkspaceEntry('.GIT', '.GIT'), true);
  assert.equal(
    shouldExcludeWorkspaceEntry('node_modules', 'node_modules'),
    true,
  );
  assert.equal(
    shouldExcludeWorkspaceEntry('NODE_MODULES', 'NODE_MODULES'),
    true,
  );
  assert.equal(shouldExcludeWorkspaceEntry('docs', 'docs'), false);
});

void test('getExcludedContentSearchGlobs exposes the shared ripgrep excludes', () => {
  assert.deepEqual(getExcludedContentSearchGlobs(), [
    '!.git/',
    '!.geulbat/',
    '!node_modules/',
  ]);
});
