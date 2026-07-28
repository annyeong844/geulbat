import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { createRunState } from '../../agent/runtime/run-state.js';
import { createDaemonContext } from '../../context.js';
import {
  commitMemoryEntries,
  readMemoryEntries,
} from '../../memories/entries-store.js';
import { createRunContext } from '../../run-context.js';
import { citeMemoryTool } from './cite-memory.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-cite-'));
}

void test('cite_memory writes Home state without touching Computer files', () => {
  assert.equal(citeMemoryTool.sideEffectLevel, 'write');
  assert.equal(citeMemoryTool.mayMutateComputerFiles, false);
  assert.equal(citeMemoryTool.requiresApproval, false);
  assert.equal(citeMemoryTool.recoveryStrategy, 'reconcile_then_replay');
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

void test('cite_memory replays one invocation without incrementing usage twice', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'count once across restart replay' },
  ]);
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
    callId: 'call-cite-replayed',
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
    computerSessionId: 'memory-citation-test-session',
    permissionMode: 'basic' as const,
    emitAgentEvent() {},
    memoryIndex: daemonContext.memoryIndex,
    runtimeServices: daemonContext,
  };

  const first = await citeMemoryTool.execute(
    { entryIds: [entryIds[0]!] },
    context,
  );
  const replay = await citeMemoryTool.execute(
    { entryIds: [entryIds[0]!] },
    context,
  );

  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  assert.equal((await readMemoryEntries(stateRoot))[0]?.usageCount, 1);
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
