import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import {
  isProviderNativeCompactionEntryData,
  type ThreadMessage,
} from '@geulbat/protocol/threads';

import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import { compactThreadContextNative } from './compaction-run.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_TIMESTAMP = '2026-07-16T00:00:00.000Z';
const TEST_REPLAY_SCOPE_ID = `sha256:${'d'.repeat(
  64,
)}` as ProviderReplayScopeId;

void test('provider-native compaction appends a checkpoint and retains the active user tail verbatim', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const original = await readTranscriptEntries(workspaceRoot, threadId);

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        compactHistory: async ({
          historyPrefix,
          evidence,
          expandedEvidencePages,
        }) => {
          assert.deepEqual(historyPrefix, history.slice(0, 2));
          assert.deepEqual(evidence, []);
          assert.deepEqual(expandedEvidencePages, []);
          return {
            providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
            providerUsageTelemetry: {
              inputTokens: 120,
              outputTokens: 15,
              cachedInputTokens: 20,
            },
            output: [
              {
                type: 'compaction',
                encrypted_content: 'opaque-checkpoint',
              },
            ],
          };
        },
        measureHistoryBytes(items) {
          return items[0]?.kind === 'provider_native_compaction' ? 20 : 100;
        },
        now: () => new Date(TEST_TIMESTAMP),
      });

      assert.equal(result.kind, 'compacted');
      if (result.kind === 'compacted') {
        assert.equal(result.providerRoundAnchorEntryId, original[2]?.entryId);
        assert.deepEqual(result.providerUsageTelemetry, {
          inputTokens: 120,
          outputTokens: 15,
          cachedInputTokens: 20,
        });
      }
      const stored = await readTranscriptEntries(workspaceRoot, threadId);
      assert.deepEqual(stored.slice(0, original.length), original);
      assert.equal(stored.length, original.length + 1);
      assert.deepEqual(history, [
        {
          kind: 'provider_native_compaction',
          providerId: 'openai_codex_direct',
          model: 'gpt-test',
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-checkpoint',
            },
          ],
        },
        { kind: 'user', text: 'continue' },
      ]);
      const checkpoint = stored.at(-1);
      assert.equal(checkpoint?.role, 'compaction');
      if (
        checkpoint?.role === 'compaction' &&
        isProviderNativeCompactionEntryData(checkpoint.compactionData)
      ) {
        assert.equal(
          checkpoint.compactionData.firstKeptEntryId,
          original[2]?.entryId,
        );
        assert.equal(
          checkpoint.compactionData.coveredThroughEntryId,
          original[1]?.entryId,
        );
        assert.equal(checkpoint.compactionData.historyBytesBefore, 100);
        assert.equal(checkpoint.compactionData.historyBytesAfter, 20);
      }
    },
  );
});

void test('provider-native compaction skips an unchanged checkpoint but retries after its policy changes', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const initial = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        compactHistory: async () => ({
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'initial-checkpoint',
            },
          ],
        }),
        measureHistoryBytes(items) {
          return items[0]?.kind === 'provider_native_compaction' ? 20 : 100;
        },
      });
      assert.equal(initial.kind, 'compacted');

      let repeatedCompactCalls = 0;
      const unchanged = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        compactHistory: async () => {
          repeatedCompactCalls += 1;
          throw new Error('must not compact an unchanged checkpoint');
        },
      });
      assert.deepEqual(unchanged, { kind: 'no_material_growth' });
      assert.equal(repeatedCompactCalls, 0);

      const changedPolicy = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 101,
        thresholdTokens: 90,
        compactHistory: async () => {
          repeatedCompactCalls += 1;
          return {
            providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
            output: [
              {
                type: 'compaction',
                encrypted_content: 'changed-policy-checkpoint',
              },
            ],
          };
        },
        measureHistoryBytes(items) {
          return items === history ? 100 : 20;
        },
      });
      assert.equal(changedPolicy.kind, 'compacted');
      assert.equal(repeatedCompactCalls, 1);
    },
  );
});

void test('provider-native compaction leaves in-memory history untouched when transcript CAS loses a race', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const before = structuredClone(history);

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        compactHistory: async () => {
          await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
          return {
            providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
            output: [
              {
                type: 'compaction',
                encrypted_content: 'unused-checkpoint',
              },
            ],
          };
        },
        measureHistoryBytes(items) {
          return items[0]?.kind === 'provider_native_compaction' ? 20 : 100;
        },
      });

      assert.equal(result.kind, 'stale_snapshot');
      assert.deepEqual(history, before);
      const stored = await readTranscriptEntries(workspaceRoot, threadId);
      assert.deepEqual(
        stored.map((entry) => entry.role),
        ['user', 'assistant', 'user', 'user'],
      );
    },
  );
});

void test('provider-native compaction persists expanded page coordinates without recovered content', async () => {
  await withEvidenceNativeThread(
    async ({ workspaceRoot, threadId, history, outputRef }) => {
      const expandedContent = 'selected evidence page';

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        async resolveEvidencePages({
          evidence,
          retainedHistory,
          selectEvidence,
        }) {
          assert.deepEqual(evidence, [
            {
              callId: 'call-search',
              toolName: 'search_files',
              outcome: 'success',
              fullOutputBytes: 64_000,
              outputRef,
            },
          ]);
          assert.deepEqual(retainedHistory, [
            { kind: 'user', text: 'use that evidence' },
          ]);
          assert.deepEqual(
            selectEvidence({
              callId: 'call-search',
              toolName: 'search_files',
              arguments: '{"query":"owner"}',
            }),
            {
              kind: 'selected',
              evidence: evidence[0],
            },
          );
          return {
            kind: 'expanded',
            pages: [
              {
                outputRef,
                offset: 10,
                limit: 100,
                endOffset: 10 + expandedContent.length,
                totalChars: 500,
                content: expandedContent,
              },
            ],
          };
        },
        compactHistory: async ({
          historyPrefix,
          evidence,
          expandedEvidencePages,
        }) => {
          assert.equal(historyPrefix.length, 3);
          assert.equal(evidence[0]?.outputRef, outputRef);
          assert.equal(expandedEvidencePages[0]?.content, expandedContent);
          return {
            providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
            output: [
              {
                type: 'compaction_summary',
                encrypted_content: 'opaque-evidence-checkpoint',
              },
            ],
          };
        },
        measureHistoryBytes(items) {
          return items[0]?.kind === 'provider_native_compaction' ? 100 : 1000;
        },
      });

      assert.equal(result.kind, 'compacted');
      const stored = await readTranscriptEntries(workspaceRoot, threadId);
      const checkpoint = stored.at(-1);
      assert.equal(checkpoint?.role, 'compaction');
      assert.equal(JSON.stringify(checkpoint).includes(expandedContent), false);
      if (
        checkpoint?.role === 'compaction' &&
        isProviderNativeCompactionEntryData(checkpoint.compactionData)
      ) {
        assert.deepEqual(checkpoint.compactionData.evidence, [
          {
            callId: 'call-search',
            toolName: 'search_files',
            outcome: 'success',
            fullOutputBytes: 64_000,
            outputRef,
          },
        ]);
        assert.deepEqual(checkpoint.compactionData.expandedEvidencePages, [
          {
            outputRef,
            offset: 10,
            endOffset: 10 + expandedContent.length,
            totalChars: 500,
          },
        ]);
      }
    },
  );
});

void test('provider-native compaction fails without mutation when evidence selection is unavailable', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const before = structuredClone(history);
      let compactCalls = 0;

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        resolveEvidencePages: async ({ selectEvidence }) => {
          assert.deepEqual(
            selectEvidence({
              callId: 'missing-call',
              toolName: 'read_file',
              arguments: '{"path":"missing"}',
            }),
            { kind: 'failed', reason: 'target_call_not_found' },
          );
          return { kind: 'failed', reason: 'selection_unavailable' };
        },
        compactHistory: async () => {
          compactCalls += 1;
          throw new Error('must not compact');
        },
        measureHistoryBytes: () => 100,
      });

      assert.deepEqual(result, {
        kind: 'evidence_recovery_failed',
        reason: 'selection_unavailable',
      });
      assert.equal(compactCalls, 0);
      assert.deepEqual(history, before);
      assert.equal(await hasCompactionEntry(workspaceRoot, threadId), false);
    },
  );
});

void test('provider-native compaction preserves the missing output ref when evidence recovery is unavailable', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const before = structuredClone(history);
      let compactCalls = 0;

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        resolveEvidencePages: async () => ({
          kind: 'failed',
          reason: 'snapshot_unavailable',
          outputRef: 'tool-output:thread/run/missing',
        }),
        compactHistory: async () => {
          compactCalls += 1;
          throw new Error('must not compact');
        },
        measureHistoryBytes: () => 100,
      });

      assert.deepEqual(result, {
        kind: 'evidence_recovery_failed',
        reason: 'snapshot_unavailable',
        outputRef: 'tool-output:thread/run/missing',
      });
      assert.equal(compactCalls, 0);
      assert.deepEqual(history, before);
      assert.equal(await hasCompactionEntry(workspaceRoot, threadId), false);
    },
  );
});

void test('provider-native compaction rejects an invalid expanded evidence page before provider work', async () => {
  await withEvidenceNativeThread(
    async ({ workspaceRoot, threadId, history, outputRef }) => {
      const before = structuredClone(history);
      let compactCalls = 0;

      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        resolveEvidencePages: async () => ({
          kind: 'expanded',
          pages: [
            {
              outputRef,
              offset: 10,
              limit: 100,
              endOffset: 20,
              totalChars: 500,
              content: 'too short',
            },
          ],
        }),
        compactHistory: async () => {
          compactCalls += 1;
          throw new Error('must not compact invalid evidence');
        },
        measureHistoryBytes: () => 100,
      });

      assert.deepEqual(result, {
        kind: 'evidence_recovery_failed',
        reason: 'invalid_page',
      });
      assert.equal(compactCalls, 0);
      assert.deepEqual(history, before);
      assert.equal(await hasCompactionEntry(workspaceRoot, threadId), false);
    },
  );
});

void test('provider-native compaction rejects invalid provider output without mutation', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      const before = structuredClone(history);
      const result = await compactThreadContextNative({
        workspaceRoot,
        threadId,
        history,
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        tokensBefore: 90,
        contextWindow: 100,
        thresholdTokens: 90,
        compactHistory: async () => ({
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [{ type: 'message', role: 'assistant' }],
        }),
        measureHistoryBytes(items) {
          return items[0]?.kind === 'provider_native_compaction' ? 20 : 100;
        },
      });

      assert.deepEqual(result, { kind: 'provider_output_invalid' });
      assert.deepEqual(history, before);
      assert.equal(await hasCompactionEntry(workspaceRoot, threadId), false);
    },
  );
});

void test('provider-native compaction suppresses a repeated ineffective boundary', async () => {
  await withPreparedNativeThread(
    async ({ workspaceRoot, threadId, history }) => {
      let compactCalls = 0;
      const runIneffective = async (blockedAttemptKey?: string) =>
        await compactThreadContextNative({
          workspaceRoot,
          threadId,
          history,
          providerId: 'openai_codex_direct',
          model: 'gpt-test',
          tokensBefore: 90,
          contextWindow: 100,
          thresholdTokens: 90,
          ...(blockedAttemptKey === undefined ? {} : { blockedAttemptKey }),
          compactHistory: async () => {
            compactCalls += 1;
            return {
              providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
              output: [
                {
                  type: 'compaction',
                  encrypted_content: 'not-smaller',
                },
              ],
            };
          },
          measureHistoryBytes: () => 100,
        });

      const first = await runIneffective();
      assert.equal(first.kind, 'ineffective');
      if (first.kind !== 'ineffective') {
        throw new Error('expected ineffective compaction');
      }
      const repeated = await runIneffective(first.attemptKey);
      assert.deepEqual(repeated, {
        kind: 'repeated_ineffective',
        attemptKey: first.attemptKey,
      });
      assert.equal(compactCalls, 1);
      assert.equal(await hasCompactionEntry(workspaceRoot, threadId), false);
    },
  );
});

void test('provider-native compaction does not compact the only active user turn', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'current');
    let compactCalls = 0;
    const result = await compactThreadContextNative({
      workspaceRoot,
      threadId,
      history: [{ kind: 'user', text: 'current' }],
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      tokensBefore: 90,
      contextWindow: 100,
      thresholdTokens: 90,
      compactHistory: async () => {
        compactCalls += 1;
        throw new Error('must not compact');
      },
    });
    assert.deepEqual(result, { kind: 'no_summarizable_prefix' });
    assert.equal(compactCalls, 0);
  });
});

async function withPreparedNativeThread(
  run: (args: {
    workspaceRoot: string;
    threadId: string;
    history: HistoryItem[];
  }) => Promise<void>,
): Promise<void> {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'continue');
    await run({
      workspaceRoot,
      threadId,
      history: [
        { kind: 'user', text: 'old' },
        { kind: 'assistant', phase: 'final_answer', text: 'answer' },
        { kind: 'user', text: 'continue' },
      ],
    });
  });
}

async function withEvidenceNativeThread(
  run: (args: {
    workspaceRoot: string;
    threadId: string;
    history: HistoryItem[];
    outputRef: string;
  }) => Promise<void>,
): Promise<void> {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const outputRef = `tool-output:${threadId}/run-search/call-search`;
    await appendMessage(workspaceRoot, threadId, 'user', 'find the owner');
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-search',
        tool: 'search_files',
        args: { query: 'owner' },
      }),
      timestamp: TEST_TIMESTAMP,
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-search',
        output: JSON.stringify({
          ok: true,
          offloaded: true,
          tool: 'search_files',
          callId: 'call-search',
          outputRef,
          fullOutputBytes: 64_000,
          summary: 'search_files returned matches.',
        }),
      }),
      timestamp: TEST_TIMESTAMP,
    });
    await appendMessage(workspaceRoot, threadId, 'user', 'use that evidence');
    await run({
      workspaceRoot,
      threadId,
      outputRef,
      history: [
        { kind: 'user', text: 'find the owner' },
        {
          kind: 'function_call',
          id: 'fc-search',
          callId: 'call-search',
          name: 'search_files',
          arguments: '{"query":"owner"}',
        },
        {
          kind: 'function_call_output',
          callId: 'call-search',
          output: JSON.stringify({
            ok: true,
            offloaded: true,
            tool: 'search_files',
            callId: 'call-search',
            outputRef,
            fullOutputBytes: 64_000,
            summary: 'search_files returned matches.',
          }),
        },
        { kind: 'user', text: 'use that evidence' },
      ],
    });
  });
}

async function hasCompactionEntry(
  workspaceRoot: string,
  threadId: string,
): Promise<boolean> {
  return (await readTranscriptEntries(workspaceRoot, threadId)).some(
    (entry) => entry.role === 'compaction',
  );
}

async function appendMessage(
  workspaceRoot: string,
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<ThreadMessage> {
  return await appendTranscriptEntry(workspaceRoot, threadId, {
    role,
    content,
    timestamp: TEST_TIMESTAMP,
  });
}

async function withThread(
  run: (args: { workspaceRoot: string; threadId: string }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-provider-native-compaction-run-'),
  );
  try {
    await run({ workspaceRoot, threadId: testThreadId(91) });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
