import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testThreadId } from '../test-support/thread-id.js';
import { createPtcExecuteCodeCellTerminalResultStore } from './ptc-execute-code-terminal-result-store.js';

void test('PTC terminal result store reports an unavailable durable read without falling back to missing', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-terminal-result-read-failure-'),
  );
  await writeFile(join(stateRoot, '.geulbat'), 'not a directory', 'utf8');

  try {
    const result = await createPtcExecuteCodeCellTerminalResultStore().read({
      stateRoot,
      threadId: testThreadId(1),
      cellId: 'ptc_cell_unavailable_durable_read',
    });

    assert.deepEqual(result, {
      ok: false,
      message: 'PTC execute_code durable terminal result is unavailable',
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
