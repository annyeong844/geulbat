import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { resolveExecCommandPersistentShellStateDirectory } from '../exec-command-shell-state.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { deleteThreadSession } from './delete-thread.js';
import { threadProjectionDirectoryName } from '../tools/tool-library-projection-path.js';
import { threadProjectionPinDeletionPort } from '../tools/tool-library-projection-store.js';
import {
  statThreadMediaFile,
  writeThreadMediaFile,
} from './media-file-store.js';
import { indexFilePath, summaryFilePath, threadFilePath } from './paths.js';
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
  const toolOutputPath = join(
    workspaceRoot,
    '.geulbat',
    'tool-outputs',
    threadId,
    'run-delete',
    'call-delete.json',
  );
  const attachmentPath = join(
    workspaceRoot,
    '.geulbat',
    'sessions',
    `${threadId}.attachments`,
    '00000000-0000-4000-8000-000000000001.bin',
  );
  const persistentShellStateDirectory =
    resolveExecCommandPersistentShellStateDirectory({
      stateRoot: workspaceRoot,
      threadId,
    });
  const persistentShellStatePath = join(
    persistentShellStateDirectory,
    'state.json',
  );

  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  await mkdir(
    join(workspaceRoot, '.geulbat', 'sessions', `${threadId}.attachments`),
    { recursive: true },
  );
  await mkdir(
    join(workspaceRoot, '.geulbat', 'tool-outputs', threadId, 'run-delete'),
    {
      recursive: true,
    },
  );
  await mkdir(persistentShellStateDirectory, { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify([
      {
        threadId,
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
  await writeFile(toolOutputPath, '{"output":"large result"}\n', 'utf8');
  await writeFile(attachmentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(persistentShellStatePath, '{"schemaVersion":1}\n', 'utf8');
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(hasTranscriptEntryCacheForTests(workspaceRoot, threadId), true);

  assert.equal(await deleteThreadSession(workspaceRoot, threadId), true);
  await assert.rejects(() => readFile(transcriptPath, 'utf8'));
  await assert.rejects(() => readFile(summaryPath, 'utf8'));
  await assert.rejects(() => readFile(toolOutputPath, 'utf8'));
  await assert.rejects(() => readFile(attachmentPath));
  await assert.rejects(() => readFile(persistentShellStatePath, 'utf8'));
  assert.equal(await readFile(indexPath, 'utf8'), '[]\n');
  assert.equal(hasTranscriptEntryCacheForTests(workspaceRoot, threadId), false);
});

void test('deleteThreadSession removes run journals, checkpoints, and plan state', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-thread-'));
  const threadId = testThreadId(4);
  const transcriptPath = threadFilePath(workspaceRoot, threadId);
  const journalPath = join(
    workspaceRoot,
    '.geulbat',
    'run-event-journals',
    threadId,
    'run-delete.jsonl',
  );
  const checkpointPath = join(
    workspaceRoot,
    '.geulbat',
    'run-checkpoints',
    `${threadId}.json`,
  );
  const planStatePath = join(
    workspaceRoot,
    '.geulbat',
    'tool-state',
    'update-plan',
    `${threadId}.json`,
  );
  const projectionPinPath = join(
    workspaceRoot,
    '.geulbat',
    'tool-library',
    'projections',
    threadProjectionDirectoryName(threadId),
    'projection-pin.json',
  );
  const sharedProjectionContentPath = join(
    workspaceRoot,
    '.geulbat',
    'tool-library',
    'projections',
    'content',
    `sha256-${'c'.repeat(64)}`,
    'manifest.js',
  );
  // 다른 스레드의 같은 종류 상태는 남아야 한다.
  const otherThreadId = testThreadId(5);
  const otherCheckpointPath = join(
    workspaceRoot,
    '.geulbat',
    'run-checkpoints',
    `${otherThreadId}.json`,
  );

  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  await mkdir(dirname(journalPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  await mkdir(dirname(planStatePath), { recursive: true });
  await writeFile(
    transcriptPath,
    JSON.stringify({
      role: 'user',
      content: 'hello',
      timestamp: '2026-07-27T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  await writeFile(journalPath, '{"schemaVersion":1}\n', 'utf8');
  await writeFile(checkpointPath, '{"schemaVersion":1}\n', 'utf8');
  await writeFile(planStatePath, '{"schemaVersion":1}\n', 'utf8');
  await writeFile(otherCheckpointPath, '{"schemaVersion":1}\n', 'utf8');
  await mkdir(dirname(projectionPinPath), { recursive: true });
  await writeFile(projectionPinPath, '{"schemaVersion":1}\n', 'utf8');
  await mkdir(dirname(sharedProjectionContentPath), { recursive: true });
  await writeFile(
    sharedProjectionContentPath,
    'export const m = {};\n',
    'utf8',
  );

  assert.equal(
    await deleteThreadSession(
      workspaceRoot,
      threadId,
      threadProjectionPinDeletionPort,
    ),
    true,
  );
  await assert.rejects(() => readFile(journalPath, 'utf8'));
  await assert.rejects(() => readFile(checkpointPath, 'utf8'));
  await assert.rejects(() => readFile(planStatePath, 'utf8'));
  assert.equal(
    await readFile(otherCheckpointPath, 'utf8'),
    '{"schemaVersion":1}\n',
  );
  await assert.rejects(() => readFile(projectionPinPath, 'utf8'));
  // 공유 projection 콘텐츠는 다른 스레드가 참조할 수 있으므로 남아야 한다.
  assert.equal(
    await readFile(sharedProjectionContentPath, 'utf8'),
    'export const m = {};\n',
  );
});

void test('deleteThreadSession clears transcript cache when artifact deletion fails', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-thread-'));
  const threadId = testThreadId(3);
  const transcriptPath = threadFilePath(workspaceRoot, threadId);
  const summaryPath = summaryFilePath(workspaceRoot, threadId);

  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  await writeFile(
    transcriptPath,
    JSON.stringify({
      role: 'user',
      content: 'hello',
      timestamp: '2026-03-26T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  await mkdir(summaryPath);
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(hasTranscriptEntryCacheForTests(workspaceRoot, threadId), true);

  await assert.rejects(() => deleteThreadSession(workspaceRoot, threadId));
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

void test('deleteThreadSession removes the thread media directory', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-delete-thread-media-'),
  );
  const threadId = testThreadId(4);

  const written = await writeThreadMediaFile({
    workspaceRoot,
    threadId,
    extension: 'mp4',
    bytes: new TextEncoder().encode('media-to-delete'),
    maxBytes: 1024,
  });
  assert.ok(
    await statThreadMediaFile({
      workspaceRoot,
      threadId,
      mediaRef: written.mediaRef,
    }),
  );

  assert.equal(await deleteThreadSession(workspaceRoot, threadId), true);
  assert.equal(
    await statThreadMediaFile({
      workspaceRoot,
      threadId,
      mediaRef: written.mediaRef,
    }),
    null,
  );
});
