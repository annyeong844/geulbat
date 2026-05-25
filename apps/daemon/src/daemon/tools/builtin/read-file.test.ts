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
