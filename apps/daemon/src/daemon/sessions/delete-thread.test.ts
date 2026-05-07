import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { deleteThreadSession } from './delete-thread.js';
import { indexFilePath, summaryFilePath, threadFilePath } from './paths.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  hasTranscriptEntryCacheForTests,
  readTranscriptEntries,
  resetTranscriptEntryCacheForTests,
} from './transcript-log.js';

void test('deleteThreadSession removes transcript, summary, and thread index entry', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-thread-'));
  const threadId = testThreadId(1);
  const transcriptPath = threadFilePath(workspaceRoot, threadId);
  const summaryPath = summaryFilePath(workspaceRoot, threadId);
  const indexPath = indexFilePath(workspaceRoot);

  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify([
      {
        threadId,
        projectId: 'workspace',
        title: 'Delete me',
        lastUpdated: '2026-03-26T00:00:00.000Z',
        messageCount: 1,
      },
    ]) + '\n',
    'utf8',
  );
  await writeFile(
    transcriptPath,
    JSON.stringify({
      role: 'user',
      content: 'hello',
      timestamp: '2026-03-26T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  await writeFile(summaryPath, '# Summary\n', 'utf8');
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(hasTranscriptEntryCacheForTests(workspaceRoot, threadId), true);

  assert.equal(await deleteThreadSession(workspaceRoot, threadId), true);
  await assert.rejects(() => readFile(transcriptPath, 'utf8'));
  await assert.rejects(() => readFile(summaryPath, 'utf8'));
  assert.equal(await readFile(indexPath, 'utf8'), '[]\n');
  assert.equal(hasTranscriptEntryCacheForTests(workspaceRoot, threadId), false);
});

void test('deleteThreadSession returns false when no session artifacts exist', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-thread-'));

  assert.equal(
    await deleteThreadSession(workspaceRoot, testThreadId(2)),
    false,
  );
});
