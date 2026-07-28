import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { createDaemonContext } from '../../context.js';
import { listPendingMemoryNotes } from '../../memories/notes-store.js';
import { createRunContext } from '../../run-context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { writeMemoryNoteTool } from './write-memory-note.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-note-tool-'));
}

void test('write_memory_note writes Home state without touching Computer files', () => {
  assert.equal(writeMemoryNoteTool.sideEffectLevel, 'write');
  assert.equal(writeMemoryNoteTool.mayMutateComputerFiles, false);
  assert.equal(writeMemoryNoteTool.requiresApproval, false);
  assert.equal(writeMemoryNoteTool.recoveryStrategy, 'reconcile_then_replay');
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

void test('write_memory_note replays one invocation without duplicating its note', async () => {
  const stateRoot = await makeStateRoot();
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const runContext = createRunContext({
    threadId,
    stateRoot,
    workingDirectory: stateRoot,
  });
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  const signal = new AbortController().signal;
  const context = {
    kind: 'agent' as const,
    runOwnerKind: 'root_main' as const,
    callId: 'call-note-replayed',
    stateRoot,
    workingDirectory: stateRoot,
    threadId,
    runId,
    runState: createRunState({ runId, runContext }),
    signal,
    runSignal: signal,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: true,
    computerSessionId: 'memory-note-test-session',
    permissionMode: 'basic' as const,
    emitAgentEvent() {},
    memoryIndex: daemonContext.memoryIndex,
    runtimeServices: daemonContext,
  };

  const first = await writeMemoryNoteTool.execute(
    { note: '재시작 뒤에도 하나만 남는다' },
    context,
  );
  const replay = await writeMemoryNoteTool.execute(
    { note: '재시작 뒤에도 하나만 남는다' },
    context,
  );

  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  assert.deepEqual(
    (await listPendingMemoryNotes(stateRoot)).map((note) => note.text),
    ['재시작 뒤에도 하나만 남는다'],
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
