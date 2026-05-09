import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateRunningRun,
  activateCommittedArtifact,
  appendAssistantAnswerText,
  appendAssistantTranscriptTextToActiveRun,
  appendSubagentActivityToActiveRun,
  appendTranscriptActivity,
  clearPendingApprovalState,
  setPendingApproval,
  setRunErrorState,
  setRunSyncFailedState,
} from './run-session-active-run-view.js';
import {
  createEmptyActiveRunView,
  type ActiveRunViewState,
} from './run-session-state-types.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const RUN_ID = brandRunId('run-1');

void test('activateCommittedArtifact preserves finalAnswerText and promotes committed artifact ref', () => {
  const initial = {
    ...createEmptyActiveRunView(THREAD_ID),
    finalAnswerText:
      '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
  };

  const committed = activateCommittedArtifact(initial, THREAD_ID, {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# title',
    digest: '요약',
    contentHash: 'hash',
    createdAt: '2026-03-24T00:00:01.000Z',
    createdByRunId: RUN_ID,
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: null,
  });

  assert.equal(committed.finalAnswerText, initial.finalAnswerText);
  assert.deepEqual(committed.activeArtifactRef, {
    artifactId: 'art_1',
    version: 1,
  });
});

void test('activateRunningRun clears pending approval state and records the acknowledged run', () => {
  const initial = {
    ...createEmptyActiveRunView(null),
    finalAnswerText: 'commentary',
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    streamError: '[internal] failed',
  };

  const running = activateRunningRun(initial, THREAD_ID, RUN_ID);

  assert.equal(running.threadId, THREAD_ID);
  assert.equal(running.runId, RUN_ID);
  assert.equal(running.pendingApproval, null);
  assert.equal(running.streamError, null);
  assert.equal(running.finalAnswerText, 'commentary');
});

void test('clearPendingApprovalState clears approval and streamError but preserves other run view state', () => {
  const initial = {
    ...createEmptyActiveRunView(THREAD_ID),
    runId: RUN_ID,
    finalAnswerText: 'final answer',
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    streamError: '[internal] failed',
  };

  const cleared = clearPendingApprovalState(initial);

  assert.equal(cleared.pendingApproval, null);
  assert.equal(cleared.streamError, null);
  assert.equal(cleared.runId, RUN_ID);
  assert.equal(cleared.finalAnswerText, 'final answer');
});

void test('setRunErrorState clears the active run id and records the error message', () => {
  const initial = {
    ...createEmptyActiveRunView(THREAD_ID),
    runId: RUN_ID,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
  };

  const errored = setRunErrorState(initial, THREAD_ID, '[internal] failed');

  assert.equal(errored.threadId, THREAD_ID);
  assert.equal(errored.runId, null);
  assert.equal(errored.pendingApproval, null);
  assert.equal(errored.streamError, '[internal] failed');
});

void test('setRunSyncFailedState preserves the active run id and records the sync failure', () => {
  const initial = {
    ...createEmptyActiveRunView(THREAD_ID),
    runId: RUN_ID,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    finalAnswerText: 'final answer',
  };

  const syncFailed = setRunSyncFailedState(initial, THREAD_ID, 'sync failed');

  assert.equal(syncFailed.threadId, THREAD_ID);
  assert.equal(syncFailed.runId, RUN_ID);
  assert.equal(syncFailed.pendingApproval, null);
  assert.equal(syncFailed.streamError, 'sync failed');
  assert.equal(syncFailed.finalAnswerText, 'final answer');
});

void test('appendAssistantAnswerText keeps existing transcript and extends final answer text', () => {
  const initial: ActiveRunViewState = {
    ...createEmptyActiveRunView(null),
    transcriptEntries: [{ kind: 'assistant_text', text: 'thinking' }],
    finalAnswerText: 'hello',
  };

  const next = appendAssistantAnswerText(initial, THREAD_ID, ' world');

  assert.equal(next.threadId, THREAD_ID);
  assert.equal(next.finalAnswerText, 'hello world');
  assert.deepEqual(next.transcriptEntries, initial.transcriptEntries);
});

void test('appendAssistantTranscriptTextToActiveRun appends transcript text on the active run view', () => {
  const initial = createEmptyActiveRunView(null);

  const next = appendAssistantTranscriptTextToActiveRun(
    initial,
    THREAD_ID,
    'Thinking...',
  );

  assert.equal(next.threadId, THREAD_ID);
  assert.deepEqual(next.transcriptEntries, [
    { kind: 'assistant_text', text: 'Thinking...' },
  ]);
});

void test('appendTranscriptActivity appends structured transcript activity entries', () => {
  const initial = createEmptyActiveRunView(THREAD_ID);

  const next = appendTranscriptActivity(initial, THREAD_ID, {
    kind: 'tool_activity',
    tool: 'write_file',
    state: 'running',
  });

  assert.equal(next.threadId, THREAD_ID);
  assert.deepEqual(next.transcriptEntries, [
    { kind: 'tool_activity', tool: 'write_file', state: 'running' },
  ]);
});

void test('setPendingApproval appends the approval entry and stores the pending approval', () => {
  const pendingApproval = makeApprovalRequiredFixture({
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const initial = createEmptyActiveRunView(null);

  const next = setPendingApproval(initial, THREAD_ID, pendingApproval);

  assert.equal(next.threadId, THREAD_ID);
  assert.equal(next.pendingApproval, pendingApproval);
  assert.deepEqual(next.transcriptEntries, [
    {
      kind: 'approval_request',
      pendingApproval,
    },
  ]);
});

void test('setPendingApproval keeps approvals with matching callId but different run identities queued', () => {
  const firstApproval = makeApprovalRequiredFixture({
    callId: 'shared-call',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const secondApproval = makeApprovalRequiredFixture({
    callId: 'shared-call',
    runId: brandRunId('run-child-1'),
    threadId: brandThreadId('00000000-0000-4000-8000-000000000002'),
  });
  const withFirst = setPendingApproval(
    createEmptyActiveRunView(THREAD_ID),
    THREAD_ID,
    firstApproval,
  );

  const withBoth = setPendingApproval(withFirst, THREAD_ID, secondApproval);

  assert.equal(withBoth.pendingApproval, firstApproval);
  assert.deepEqual(withBoth.pendingApprovals, [firstApproval, secondApproval]);
});

void test('setPendingApproval dedupes replayed approvals with the same run identity', () => {
  const firstApproval = makeApprovalRequiredFixture({
    callId: 'replayed-call',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const replayedApproval = makeApprovalRequiredFixture({
    callId: 'replayed-call',
    runId: RUN_ID,
    threadId: THREAD_ID,
    argumentsPreview: {
      path: 'same-approval-replay.md',
    },
  });
  const withFirst = setPendingApproval(
    createEmptyActiveRunView(THREAD_ID),
    THREAD_ID,
    firstApproval,
  );

  const withReplay = setPendingApproval(withFirst, THREAD_ID, replayedApproval);

  assert.equal(withReplay.pendingApproval, firstApproval);
  assert.deepEqual(withReplay.pendingApprovals, [firstApproval]);
});

void test('appendSubagentActivityToActiveRun dedupes terminal replay entries by deliveryId', () => {
  const entry = {
    kind: 'subagent_activity' as const,
    childRunId: 'run-child-1',
    subagentType: 'worker' as const,
    state: 'completed' as const,
    deliveryId: 'delivery-1',
  };
  const initial = {
    ...createEmptyActiveRunView(THREAD_ID),
    transcriptEntries: [entry],
  };

  const next = appendSubagentActivityToActiveRun(initial, entry);

  assert.equal(next, initial);
});
