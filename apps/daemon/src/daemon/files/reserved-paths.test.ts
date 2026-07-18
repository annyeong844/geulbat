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
  assert.equal(isReservedPath('Users/sample/repo/.geulbat/state.json'), true);
  assert.equal(isReservedPath('Users/sample/repo/.git/config'), true);
  assert.equal(isReservedPath('Users/sample/repo/.env.production'), true);
  assert.equal(isReservedPath('Users\\sample\\repo\\.npmrc'), true);
  assert.equal(isReservedPath('Users/sample/repo/.envrc'), true);
  assert.equal(isReservedPath('Users/sample/repo/.yarnrc.yml'), true);
});

void test('isReservedPath does not over-block unrelated filenames', () => {
  assert.equal(isReservedPath('.environment'), false);
  assert.equal(isReservedPath('docs/.env-guide.md'), false);
  assert.equal(isReservedPath('docs/.gitignore'), false);
  assert.equal(isReservedPath('docs/environment/.npmrc-guide.md'), false);
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
    '!**/.git/**',
    '!.geulbat/',
    '!**/.geulbat/**',
    '!node_modules/',
    '!**/node_modules/**',
    '!.env',
    '!**/.env',
    '!.env.*',
    '!**/.env.*',
    '!.envrc',
    '!**/.envrc',
    '!.npmrc',
    '!**/.npmrc',
    '!.yarnrc.yml',
    '!**/.yarnrc.yml',
  ]);
});
