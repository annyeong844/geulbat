import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPendingMemoryNotes } from '../../memories/notes-store.js';
import { writeMemoryNoteTool } from './write-memory-note.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-note-tool-'));
}

void test('write_memory_note writes Home state without touching Computer files', () => {
  assert.equal(writeMemoryNoteTool.sideEffectLevel, 'write');
  assert.equal(writeMemoryNoteTool.mayMutateComputerFiles, false);
  assert.equal(writeMemoryNoteTool.requiresApproval, false);
});

void test('write_memory_note persists a note the next session can read', async () => {
  const stateRoot = await makeStateRoot();

  const result = await writeMemoryNoteTool.execute(
    { note: '이 저장소의 lint는 샤딩되어 있다' },
    { callId: 'call-note-ok', stateRoot },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    (await listPendingMemoryNotes(stateRoot)).map((note) => note.text),
    ['이 저장소의 lint는 샤딩되어 있다'],
  );
});

void test('write_memory_note rejects an empty note at the parser boundary', async () => {
  const stateRoot = await makeStateRoot();

  const result = await writeMemoryNoteTool.execute(
    { note: '  ' },
    { callId: 'call-note-empty', stateRoot },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
});

void test('write_memory_note refuses when Home state storage is unavailable', async () => {
  const result = await writeMemoryNoteTool.execute(
    { note: 'no home state' },
    { callId: 'call-note-no-state' },
  );

  assert.equal(result.ok, false);
});
