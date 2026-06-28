import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileTool } from './read-file.js';

void test('read_file rejects non-numeric offset with invalid_args and a path-based message', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt', offset: '1' },
    { callId: 'call-read-1', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /offset:/);
});

void test('read_file rejects fractional paging coordinates at the parser boundary', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');

  const fractionalOffset = await readFileTool.execute(
    { path: 'hello.txt', offset: 1.5 },
    { callId: 'call-read-fractional-offset', workspaceRoot },
  );
  assert.equal(fractionalOffset.ok, false);
  assert.equal(fractionalOffset.errorCode, 'invalid_args');
  assert.match(fractionalOffset.error ?? '', /offset.*non-negative integer/);

  const fractionalLimit = await readFileTool.execute(
    { path: 'hello.txt', limit: 1.5 },
    { callId: 'call-read-fractional-limit', workspaceRoot },
  );
  assert.equal(fractionalLimit.ok, false);
  assert.equal(fractionalLimit.errorCode, 'invalid_args');
  assert.match(fractionalLimit.error ?? '', /limit.*positive integer/);
});

void test('read_file rejects blank path at the parser boundary', async () => {
  const result = await readFileTool.execute(
    { path: '   ' },
    { callId: 'call-read-blank-path', workspaceRoot: '/workspace/project' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('read_file returns the whole file when limit is omitted', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'a\nb\nc\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt' },
    { callId: 'call-read-full', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    content: string;
    hasMore?: boolean;
    nextOffset?: number | null;
    truncated?: boolean;
  };
  assert.equal(payload.content, 'a\nb\nc\n');
  assert.equal(payload.hasMore, false);
  assert.equal(payload.nextOffset, null);
  assert.equal(Object.hasOwn(payload, 'truncated'), false);
});

void test('read_file returns an explicit page with a continuation offset', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-tool-page-'),
  );
  await writeFile(join(workspaceRoot, 'hello.txt'), 'a\nb\nc\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt', offset: 1, limit: 1 },
    { callId: 'call-read-page', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    content: string;
    startLine: number;
    endLine: number;
    hasMore?: boolean;
    nextOffset?: number | null;
    truncated?: boolean;
  };
  assert.equal(payload.content, 'b\n');
  assert.equal(payload.startLine, 2);
  assert.equal(payload.endLine, 2);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.nextOffset, 2);
  assert.equal(Object.hasOwn(payload, 'truncated'), false);
});

void test('read_file explicit pages preserve full-file versionToken', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-tool-page-'),
  );
  await writeFile(
    join(workspaceRoot, 'hello.txt'),
    '\uFEFFa\r\nb\r\nc',
    'utf8',
  );

  const fullResult = await readFileTool.execute(
    { path: 'hello.txt' },
    { callId: 'call-read-token-full', workspaceRoot },
  );
  const pageResult = await readFileTool.execute(
    { path: 'hello.txt', offset: 1, limit: 1 },
    { callId: 'call-read-token-page', workspaceRoot },
  );

  assert.equal(fullResult.ok, true);
  assert.equal(pageResult.ok, true);
  const fullPayload = JSON.parse(fullResult.output) as {
    content: string;
    versionToken: string;
  };
  const pagePayload = JSON.parse(pageResult.output) as {
    content: string;
    totalLines: number;
    versionToken: string;
  };
  assert.equal(fullPayload.content, 'a\nb\nc\n');
  assert.equal(pagePayload.content, 'b\n');
  assert.equal(pagePayload.totalLines, 3);
  assert.equal(pagePayload.versionToken, fullPayload.versionToken);
});
