import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { testThreadId } from '../../../test-support/thread-id.js';
import { readToolOutputTool } from './read-tool-output.js';

void test('read_tool_output rejects raw .geulbat paths instead of treating them as references', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));

  const result = await readToolOutputTool.execute(
    { outputRef: '.geulbat/tool-outputs/thread/run/call.json' },
    {
      callId: 'call-read-tool-output-path',
      workspaceRoot,
      threadId: testThreadId(81),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /tool-output reference/);
});

void test('read_tool_output rejects output refs from another thread', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(82);
  const otherThreadId = testThreadId(83);

  const result = await readToolOutputTool.execute(
    { outputRef: `tool-output:${otherThreadId}/run-search/call-search` },
    {
      callId: 'call-read-tool-output-cross-thread',
      workspaceRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
  assert.match(result.error ?? '', /does not belong to this thread/);
});

void test('read_tool_output returns not_found for a missing snapshot in the current thread', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(86);

  const result = await readToolOutputTool.execute(
    { outputRef: `tool-output:${currentThreadId}/run-search/call-search` },
    {
      callId: 'call-read-tool-output-missing-snapshot',
      workspaceRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
  assert.match(result.error ?? '', /not found/);
});

void test('read_tool_output rejects snapshots whose schema identity does not match the ref', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(84);
  const otherThreadId = testThreadId(85);
  const outputRef = `tool-output:${currentThreadId}/run-search/call-search`;
  const snapshotDir = join(
    workspaceRoot,
    '.geulbat',
    'tool-outputs',
    currentThreadId,
    'run-search',
  );
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(
    join(snapshotDir, 'call-search.json'),
    JSON.stringify({
      schemaVersion: 1,
      outputRef,
      projectId: 'project',
      threadId: otherThreadId,
      runId: 'run-search',
      callId: 'call-search',
      toolName: 'search_files',
      createdAt: '2026-05-14T00:00:00.000Z',
      contentType: 'json',
      fullOutputBytes: 2,
      fullOutputChars: 2,
      output: '{}',
    }) + '\n',
    'utf8',
  );

  const result = await readToolOutputTool.execute(
    { outputRef },
    {
      callId: 'call-read-tool-output-mismatched-snapshot',
      workspaceRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'internal');
  assert.match(result.error ?? '', /expected schema/);
});
