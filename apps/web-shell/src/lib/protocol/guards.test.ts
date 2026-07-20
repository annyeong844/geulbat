import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isApprovalRequired,
  isApprovalResponse,
} from '@geulbat/protocol/run-approval';
import {
  isConflictActiveRunError,
  isConflictStaleWriteError,
  isPersistenceApiError,
} from '@geulbat/protocol/errors';
import {
  isFileReadResponse,
  isFileSaveResponse,
  isFileTreeResponse,
} from '@geulbat/protocol/files';
import { isThreadId } from '@geulbat/protocol/ids';
import {
  isProviderAuthLogoutResponse,
  isProviderAuthStartResponse,
  isProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import { isJsonValue } from '@geulbat/protocol/runtime-persistence';
import {
  isThreadDeleteResponse,
  isThreadDetailResponse,
  isThreadListResponse,
  isThreadMessage,
} from '@geulbat/protocol/threads';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { brandRunId, brandThreadId } from '../id-brand-helpers.js';

const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);
const RUN_ID = brandRunId('run-1');

void test('isApprovalRequired accepts protocol-shaped approval payload', () => {
  assert.equal(
    isApprovalRequired(
      makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
        argumentsPreview: { path: 'hello.txt' },
      }),
    ),
    true,
  );
});

void test('isApprovalRequired rejects malformed enum values', () => {
  assert.equal(
    isApprovalRequired(
      makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
        permissionMode: 'god_mode' as never,
      }),
    ),
    false,
  );

  assert.equal(
    isApprovalRequired(
      makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
        sideEffectLevel: 'mutate_all' as never,
      }),
    ),
    false,
  );
});

void test('isApprovalResponse accepts protocol approval acknowledgements', () => {
  assert.equal(isApprovalResponse({ ok: true }), true);
});

void test('API response guards accept protocol-shaped payloads', () => {
  const cases: Array<{
    label: string;
    guard: (value: unknown) => boolean;
    value: unknown;
  }> = [
    {
      label: 'stale write',
      guard: isConflictStaleWriteError,
      value: {
        code: 'conflict_stale_write',
        message: 'stale write',
        path: 'hello.txt',
        currentVersionToken: 'token-1',
      },
    },
    {
      label: 'active run conflict',
      guard: isConflictActiveRunError,
      value: {
        code: 'conflict_active_run',
        message: 'thread has active run',
        threadId: THREAD_ID_VALUE,
        activeRunId: 'run-1',
      },
    },
    {
      label: 'file read',
      guard: isFileReadResponse,
      value: {
        path: 'docs/sample.md',
        content: 'doc content\n',
        versionToken: 'token-2',
        totalLines: 1,
        startLine: 1,
        endLine: 1,
      },
    },
    {
      label: 'file save',
      guard: isFileSaveResponse,
      value: {
        path: 'docs/sample.md',
        versionToken: 'token-3',
        totalLines: 1,
        ok: true,
      },
    },
    {
      label: 'thread list',
      guard: isThreadListResponse,
      value: {
        threads: [
          {
            threadId: THREAD_ID_VALUE,
            title: 'Smoke',
            lastUpdated: '2026-03-24T00:00:00.000Z',
            messageCount: 2,
          },
        ],
      },
    },
    {
      label: 'thread detail',
      guard: isThreadDetailResponse,
      value: {
        threadId: THREAD_ID_VALUE,
        snapshotVersion: '2026-03-24T00:00:00.000Z',
        messages: [
          {
            entryId: 'entry-thread-detail',
            role: 'assistant',
            content: 'hello',
            timestamp: '2026-03-24T00:00:00.000Z',
            metadata: { phase: 'final_answer' },
          },
        ],
      },
    },
    {
      label: 'thread delete',
      guard: isThreadDeleteResponse,
      value: {
        ok: true,
        threadId: THREAD_ID_VALUE,
      },
    },
    {
      label: 'provider auth start',
      guard: isProviderAuthStartResponse,
      value: {
        authSessionId: 'auth-1',
        authorizeUrl: 'https://example.com',
        expiresAt: 123,
        providerId: 'openai_codex_direct',
      },
    },
    {
      label: 'provider auth status',
      guard: isProviderAuthStatusResponse,
      value: {
        state: 'ready',
        ready: true,
        expiresAt: 123,
      },
    },
    {
      label: 'provider auth logout',
      guard: isProviderAuthLogoutResponse,
      value: { ok: true },
    },
  ];

  for (const { label, guard, value } of cases) {
    assert.equal(guard(value), true, label);
  }
});

void test('protocol persistence and identity guards accept valid values', () => {
  assert.equal(
    isPersistenceApiError({
      code: 'persistence_conflict',
      message: 'stale revision',
    }),
    true,
  );

  assert.equal(
    isJsonValue({
      ok: true,
      nested: ['value', 1, false, null],
    }),
    true,
  );

  assert.equal(
    isJsonValue({
      invalid: new Date(),
    }),
    false,
  );
  assert.equal(isThreadId(THREAD_ID_VALUE), true);

  assert.equal(
    isThreadMessage({
      entryId: 'entry-valid',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-03-24T00:00:00.000Z',
      metadata: { phase: 'final_answer' },
    }),
    true,
  );
});

void test('thread response guards reject malformed thread ids and message metadata', () => {
  assert.equal(
    isThreadListResponse({
      threads: [
        {
          threadId: 'thread-1',
          lastUpdated: '2026-03-24T00:00:00.000Z',
          messageCount: 1,
        },
      ],
    }),
    false,
  );

  assert.equal(
    isThreadDetailResponse({
      threadId: THREAD_ID_VALUE,
      snapshotVersion: '2026-03-24T00:00:00.000Z',
      messages: [
        {
          entryId: 'entry-bad-metadata',
          role: 'assistant',
          content: 'hello',
          timestamp: '2026-03-24T00:00:00.000Z',
          metadata: 'bad-metadata',
        },
      ],
    }),
    false,
  );

  assert.equal(
    isThreadMessage({
      entryId: 'entry-bad-message-metadata',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-03-24T00:00:00.000Z',
      metadata: { kind: 'final' },
    }),
    false,
  );
});

void test('brand helpers reject malformed run ids', () => {
  assert.equal(brandRunId('run-1'), RUN_ID);

  assert.throws(() => brandRunId(''), /invalid runId/i);
  assert.throws(() => brandRunId('run with spaces'), /invalid runId/i);
});

void test('isFileTreeResponse rejects malformed tree payload', () => {
  assert.equal(
    isFileTreeResponse({
      root: 'computer',
      tree: [
        {
          name: 'docs',
          path: 'docs',
          type: 'directory',
          children: [{ bad: true }],
        },
      ],
    }),
    false,
  );
});

void test('isRunChannelServerMessage accepts all run.event payload variants', () => {
  const cases = [
    makeRunEvent('run_ack', {
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    makeRunEvent('commentary_delta', {
      text: 'commentary',
    }),
    makeRunEvent('final_answer_delta', {
      text: 'final',
    }),
    makeRunEvent('artifact_committed', {
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-04-10T00:00:00.000Z',
      createdByRunId: RUN_ID,
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: {
        kind: 'thread-file',
        workingDirectory: 'computer-root',
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    }),
    makeRunEvent('tool_call', {
      callId: 'call-1',
      step: 0,
      tool: 'read_file',
      args: { path: 'hello.txt' },
    }),
    makeRunEvent('tool_result', {
      callId: 'call-1',
      step: 0,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'hello.txt' },
    }),
    makeRunEvent('approval_required', {
      ...makeApprovalRequiredFixture({
        callId: 'call-2',
        runId: RUN_ID,
        threadId: THREAD_ID,
        argumentsPreview: { path: 'hello.txt' },
      }),
    }),
    makeRunEvent('subagent_terminal', {
      deliveryId: 'delivery-1',
      parentRunId: RUN_ID,
      childRunId: 'child-1',
      subagentType: 'explorer',
      terminalState: 'completed',
      ok: true,
      result: 'done',
    }),
    makeRunEvent('interject_applied', {
      runId: RUN_ID,
      count: 1,
      receivedSeqs: [1],
    }),
    makeRunEvent('thread_state_persisted', {
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
      messages: [],
      artifacts: [],
    }),
    makeRunEvent('thread_state_persist_failed', {
      message: 'sync failed',
    }),
    makeRunEvent('done', {
      answer: 'done',
      ok: true,
    }),
    makeRunEvent('error', {
      code: 'internal',
      message: 'boom',
    }),
  ];

  for (const message of cases) {
    assert.equal(isRunChannelServerMessage(message), true);
  }
});

void test('isRunChannelServerMessage rejects malformed run.event payloads', () => {
  const invalidCases = [
    makeRunEvent('subagent_terminal', {
      deliveryId: 'delivery-2',
      parentRunId: RUN_ID,
      childRunId: 'child-1',
      terminalState: 'completed',
      ok: true,
      result: 'done',
    }),
    makeRunEvent('tool_result', {
      callId: 'call-1',
      step: 0,
      tool: 'read_file',
      ok: true,
      displayText: 'ok',
    }),
    makeRunEvent('run_ack', {
      runId: RUN_ID,
      threadId: 'thread-1',
    }),
  ];

  for (const message of invalidCases) {
    assert.equal(isRunChannelServerMessage(message), false);
  }
});

function makeRunEvent(type: string, payload: Record<string, unknown>) {
  return {
    type: 'run.event',
    event: {
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 1,
      type,
      ts: '2026-03-24T00:00:00.000Z',
      payload,
    },
  };
}
