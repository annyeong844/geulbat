import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { isToolObjectParameters } from '../tool-registry-model.js';
import { readFileTool } from './read-file.js';

void test('read_file provider schema requires an explicit bounded limit', () => {
  const parameters = readFileTool.parameters;
  assert.equal(isToolObjectParameters(parameters), true);
  if (!isToolObjectParameters(parameters)) {
    assert.fail('expected object tool parameters');
  }
  assert.deepEqual(parameters.required, ['path', 'limit']);
});

void test('read_file rejects non-numeric offset with invalid_args and a path-based message', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt', offset: '1', limit: 1 },
    { callId: 'call-read-1', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /offset:/);
});

void test('read_file rejects fractional paging coordinates at the parser boundary', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const fractionalOffset = await readFileTool.execute(
    { path: 'hello.txt', offset: 1.5, limit: 1 },
    { callId: 'call-read-fractional-offset', computerFileRoot },
  );
  assert.equal(fractionalOffset.ok, false);
  assert.equal(fractionalOffset.errorCode, 'invalid_args');
  assert.match(fractionalOffset.error ?? '', /offset.*non-negative integer/);

  const fractionalLimit = await readFileTool.execute(
    { path: 'hello.txt', limit: 1.5 },
    { callId: 'call-read-fractional-limit', computerFileRoot },
  );
  assert.equal(fractionalLimit.ok, false);
  assert.equal(fractionalLimit.errorCode, 'invalid_args');
  assert.match(fractionalLimit.error ?? '', /limit.*positive integer/);
});

void test('read_file rejects blank path at the parser boundary', async () => {
  const result = await readFileTool.execute(
    { path: '   ', limit: 1 },
    { callId: 'call-read-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('read_file rejects an omitted limit instead of reading the whole file', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-tool-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'a\nb\nc\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt' },
    { callId: 'call-read-full', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /limit.*required/);
});

void test('read_file returns an explicit page with a continuation offset', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-tool-page-'),
  );
  await writeFile(join(computerFileRoot, 'hello.txt'), 'a\nb\nc\n', 'utf8');

  const result = await readFileTool.execute(
    { path: 'hello.txt', offset: 1, limit: 1 },
    { callId: 'call-read-page', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    content: string;
    startLine: number;
    endLine: number;
    pageLimit: number;
    hasMore?: boolean;
    nextOffset?: number | null;
    truncated?: boolean;
  };
  assert.equal(payload.content, 'b\n');
  assert.equal(payload.startLine, 2);
  assert.equal(payload.endLine, 2);
  assert.equal(payload.pageLimit, 1);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.nextOffset, 2);
  assert.equal(Object.hasOwn(payload, 'truncated'), false);
});

void test('read_file explicit pages preserve full-file versionToken', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-tool-page-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    '\uFEFFa\r\nb\r\nc',
    'utf8',
  );

  const firstPageResult = await readFileTool.execute(
    { path: 'hello.txt', offset: 0, limit: 1 },
    { callId: 'call-read-token-first-page', computerFileRoot },
  );
  const pageResult = await readFileTool.execute(
    { path: 'hello.txt', offset: 1, limit: 1 },
    { callId: 'call-read-token-page', computerFileRoot },
  );

  assert.equal(firstPageResult.ok, true);
  assert.equal(pageResult.ok, true);
  const firstPagePayload = JSON.parse(firstPageResult.output) as {
    content: string;
    versionToken: string;
  };
  const pagePayload = JSON.parse(pageResult.output) as {
    content: string;
    totalLines: number;
    versionToken: string;
  };
  assert.equal(firstPagePayload.content, 'a\n');
  assert.equal(pagePayload.content, 'b\n');
  assert.equal(pagePayload.totalLines, 3);
  assert.equal(pagePayload.versionToken, firstPagePayload.versionToken);
});

void test('read_file infers the computer root for an admitted absolute path', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-computer-'),
  );
  const absolutePath = join(computerFileRoot, 'outside.txt');
  await writeFile(absolutePath, 'computer file\n', 'utf8');

  const result = await readFileTool.execute(
    { path: absolutePath, limit: 1 },
    {
      callId: 'call-read-computer-absolute',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    path: string;
    content: string;
  };
  assert.equal(payload.root, 'computer');
  assert.equal(payload.path, 'outside.txt');
  assert.equal(payload.content, 'computer file\n');
});

void test('read_file fails closed when the computer root is unavailable', async () => {
  const result = await readFileTool.execute(
    { path: 'outside.txt', limit: 1 },
    { callId: 'call-read-computer-unavailable' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
  assert.match(result.error ?? '', /computer file scope is unavailable/);
});

void test('read_file rejects a safe symlink whose canonical target is reserved', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-computer-'),
  );
  const reservedTarget = join(computerFileRoot, '.env');
  const linkedPath = join(computerFileRoot, 'config-link');
  await writeFile(reservedTarget, 'SECRET=hidden\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, reservedTarget, linkedPath))) {
    return;
  }

  const result = await readFileTool.execute(
    { path: 'config-link', limit: 1 },
    {
      callId: 'call-read-computer-reserved-symlink',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
  assert.match(result.error ?? '', /reserved path: \.env/);
});

void test('read_file rejects the removed legacy root selector', async () => {
  const result = await readFileTool.execute(
    { root: 'workspace', path: 'geulbat-sdk', limit: 1 },
    { callId: 'call-read-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});
