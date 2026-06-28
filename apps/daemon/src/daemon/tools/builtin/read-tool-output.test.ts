import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { testThreadId } from '../../../test-support/thread-id.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../../files/tool-output-store.js';
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

void test('read_tool_output rejects blank outputRef at the parser boundary', async () => {
  const result = await readToolOutputTool.execute(
    { outputRef: '   ' },
    {
      callId: 'call-read-tool-output-blank-ref',
      workspaceRoot: '/workspace/project',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /outputRef is required/);
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

void test('read_tool_output reads the full snapshot by default', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(87);
  const runId = 'run-full-output';
  const callId = 'call-full-output';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const output = 'full-output-line\n'.repeat(2_000);
  await writeToolOutputSnapshot({
    workspaceRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      projectId: 'project',
      threadId,
      runId,
      callId,
      toolName: 'web_fetch',
      output,
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef },
    {
      callId: 'call-read-tool-output-full',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(result.ok, true);
  const page = JSON.parse(result.output) as {
    content?: string;
    hasMore?: boolean;
    limit?: number | null;
    nextOffset?: number | null;
    totalChars?: number;
  };
  assert.equal(page.content, output);
  assert.equal(page.hasMore, false);
  assert.equal(page.limit, null);
  assert.equal(page.nextOffset, null);
  assert.equal(page.totalChars, output.length);
});

void test('read_tool_output returns an explicit page when limit is provided', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(88);
  const runId = 'run-paged-output';
  const callId = 'call-paged-output';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const output = '0123456789'.repeat(1_000);
  await writeToolOutputSnapshot({
    workspaceRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      projectId: 'project',
      threadId,
      runId,
      callId,
      toolName: 'search_files',
      output,
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, offset: 20, limit: 15 },
    {
      callId: 'call-read-tool-output-page',
      workspaceRoot,
      threadId,
    },
  );

  assert.equal(result.ok, true);
  const page = JSON.parse(result.output) as {
    content?: string;
    endOffset?: number;
    hasMore?: boolean;
    limit?: number | null;
    nextOffset?: number | null;
    offset?: number;
    totalChars?: number;
  };
  assert.equal(page.content, output.slice(20, 35));
  assert.equal(page.offset, 20);
  assert.equal(page.limit, 15);
  assert.equal(page.endOffset, 35);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 35);
  assert.equal(page.totalChars, output.length);
  assert.equal(Object.hasOwn(page, 'truncated'), false);
});
