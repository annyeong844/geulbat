import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import { loadSummary, saveSummary } from './summary-store.js';

void test('summary store saves and loads thread summary markdown', async () => {
  const threadId = testThreadId(1);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-summary-'));

  assert.equal(await loadSummary(workspaceRoot, threadId), null);

  await saveSummary(workspaceRoot, threadId, '# Summary\n\nHello');

  const summary = await loadSummary(workspaceRoot, threadId);
  assert.equal(summary, '# Summary\n\nHello');
});
