import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldExcludeMemorySourceEntry } from './reserved-paths.js';

void test('shouldExcludeMemorySourceEntry keeps private and generated trees out of memory snapshots', () => {
  assert.equal(shouldExcludeMemorySourceEntry('.geulbat', '.geulbat'), true);
  assert.equal(shouldExcludeMemorySourceEntry('.GIT', '.GIT'), true);
  assert.equal(
    shouldExcludeMemorySourceEntry('node_modules', 'node_modules'),
    true,
  );
  assert.equal(
    shouldExcludeMemorySourceEntry('NODE_MODULES', 'NODE_MODULES'),
    true,
  );
  assert.equal(
    shouldExcludeMemorySourceEntry('repo/.env.production', '.env.production'),
    true,
  );
  assert.equal(shouldExcludeMemorySourceEntry('docs', 'docs'), false);
});
