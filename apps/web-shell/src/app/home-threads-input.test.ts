import test from 'node:test';
import assert from 'node:assert/strict';

import { brandThreadId } from '../lib/id-brand-helpers.js';
import { createHomeThreadsInput } from './home-threads-input.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

function createThreadsSourceStub() {
  const thread = {
    threadId: THREAD_ID,
    title: 'Thread',
    lastUpdated: '2026-04-11T10:00:00.000Z',
    messageCount: 1,
  };

  return {
    threads: [thread],
    threadError: 'thread failed',
    selectedThreadId: thread.threadId,
    messages: [],
    artifacts: [],
    deletingThreadId: thread.threadId,
    pendingDeleteThread: thread,
    loadThreads: async () => {},
    openThread: async () => {},
    requestDeleteThread: () => {},
    cancelDeleteThread: () => {},
    confirmDeleteThread: async () => {},
    setSelectedThreadId: () => {},
    appendOptimisticUserMessage: () => {},
    startNewSession: () => {},
    branchThreadFromEntry: async () => {},
    branchThreadBeforeEntry: async () => null,
    branchNotice: null,
    dismissBranchNotice: () => {},
    openThreadForRunSettle: async () => null,
    applyThreadSnapshotForRunSettle: () => true,
  };
}

void test('createHomeThreadsInput preserves the thread surface used by Home shell', () => {
  const threads = createThreadsSourceStub();
  const input = createHomeThreadsInput(threads);

  assert.equal(input.threads, threads.threads);
  assert.equal(input.threadError, 'thread failed');
  assert.equal(input.selectedThreadId, THREAD_ID);
  assert.equal(input.messages, threads.messages);
  assert.equal(input.artifacts, threads.artifacts);
  assert.equal(input.deletingThreadId, THREAD_ID);
  assert.equal(input.pendingDeleteThread, threads.pendingDeleteThread);
  assert.equal(input.loadThreads, threads.loadThreads);
  assert.equal(input.openThread, threads.openThread);
  assert.equal(input.requestDeleteThread, threads.requestDeleteThread);
  assert.equal(input.cancelDeleteThread, threads.cancelDeleteThread);
  assert.equal(input.confirmDeleteThread, threads.confirmDeleteThread);
  assert.equal(input.setSelectedThreadId, threads.setSelectedThreadId);
  assert.equal(
    input.appendOptimisticUserMessage,
    threads.appendOptimisticUserMessage,
  );
  assert.equal(input.branchThreadFromEntry, threads.branchThreadFromEntry);
  assert.equal(input.branchThreadBeforeEntry, threads.branchThreadBeforeEntry);
  assert.equal(input.branchNotice, threads.branchNotice);
  assert.equal(input.dismissBranchNotice, threads.dismissBranchNotice);
});
