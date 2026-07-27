import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isInterjectFlushRequested,
  peekPendingInterject,
  pushPendingInterject,
  requestInterjectFlush,
} from '../sessions/active-run-interject-buffer.js';
import { createRunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import type { HistoryItem } from '../llm/index.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { applyNextPendingInterject } from './loop-interject.js';
import { createRunState } from './runtime/run-state.js';

void test('applyNextPendingInterject preserves the live item when transcript persistence fails', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-interject-persistence-failure-'),
  );
  const threadId = testThreadId(1207);
  const runContext = makeRunContext({ threadId, stateRoot });
  const runState = createRunState({
    runId: 'run-loop-interject-persistence-failure',
    runContext,
  });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const started = await runCheckpoints.startRun({
    runId: runState.runId,
    threadId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  assert.equal(started.ok, true);

  pushPendingInterject(runState.interject, 'retain this steer');
  requestInterjectFlush(runState.interject);
  await writeFile(join(stateRoot, '.geulbat', 'sessions'), 'not-a-directory');

  const history: HistoryItem[] = [];
  let emitted = false;
  await assert.rejects(
    applyNextPendingInterject({
      history,
      workspaceRoot: stateRoot,
      runState,
      runCheckpoints,
      emit() {
        emitted = true;
      },
    }),
    /ENOTDIR|not a directory/u,
  );

  assert.deepEqual(peekPendingInterject(runState.interject), {
    receivedSeq: 1,
    text: 'retain this steer',
  });
  assert.equal(isInterjectFlushRequested(runState.interject), true);
  assert.deepEqual(history, []);
  assert.equal(emitted, false);

  const checkpoint = await runCheckpoints.readThread(threadId);
  assert.deepEqual(checkpoint?.applyingInterject, {
    receivedSeq: 1,
    text: 'retain this steer',
  });
  assert.deepEqual(checkpoint?.pendingInterjects, []);
});
