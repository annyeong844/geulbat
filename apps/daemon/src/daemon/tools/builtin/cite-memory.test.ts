import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitMemoryEntries,
  readMemoryEntries,
} from '../../memories/entries-store.js';
import { citeMemoryTool } from './cite-memory.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-cite-'));
}

void test('cite_memory writes Home state without touching Computer files', () => {
  assert.equal(citeMemoryTool.sideEffectLevel, 'write');
  assert.equal(citeMemoryTool.mayMutateComputerFiles, false);
  assert.equal(citeMemoryTool.requiresApproval, false);
});

void test('cite_memory measures a real entry and reports an unknown address', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'real entry' },
  ]);

  const result = await citeMemoryTool.execute(
    { entryIds: [entryIds[0]!, 'm-deadbeef'] },
    { callId: 'call-cite', stateRoot },
  );

  assert.equal(result.ok, true);
  assert.equal((await readMemoryEntries(stateRoot))[0]?.usageCount, 1);
  assert.match(result.output ?? '', /m-deadbeef/u);
});

void test('cite_memory rejects an empty address list at the parser boundary', async () => {
  const stateRoot = await makeStateRoot();

  const result = await citeMemoryTool.execute(
    { entryIds: [] },
    { callId: 'call-cite-empty', stateRoot },
  );

  assert.equal(result.ok, false);
});

void test('cite_memory refuses when Home state storage is unavailable', async () => {
  const result = await citeMemoryTool.execute(
    { entryIds: ['m-11111111'] },
    { callId: 'call-cite-no-state' },
  );

  assert.equal(result.ok, false);
});
