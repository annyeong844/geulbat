import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import {
  isProviderNativeCompactionEntryData,
  type BudgetProfile,
  type ThreadMessage,
} from '@geulbat/protocol/threads';

import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import {
  buildCompactionAwareHistory,
  type ContextCompactionTokenCounter,
} from './compaction-rebuild.js';
import {
  compactThreadContextForProviderTransition,
  compactThreadContextNative,
  compactThreadContext,
  compactThreadContextSummary,
  type ContextCompactionSummarizer,
} from './compaction-run.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_TIMESTAMP = '2026-07-16T00:00:00.000Z';
const TEST_REPLAY_SCOPE_ID = `sha256:${'d'.repeat(
  64,
)}` as ProviderReplayScopeId;
const TEST_BUDGET_PROFILE: BudgetProfile = {
  model: 'test-model',
  contextWindow: 100,
  reserveTokens: 10,
  thresholdTokens: 90,
  keepRecentTokens: 50,
  summaryBudgetTokens: 20,
  requestOverheadTokens: 10,
  requestProfileHash: 'test-profile',
  compactionVersion: 1,
};

void test('compaction appends one checkpoint without rewriting source entries', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const original = await readTranscriptEntries(workspaceRoot, threadId);

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      summarizer: summaryReturning('summary', 'short summary', 15),
      forced: false,
      now: () => new Date(TEST_TIMESTAMP),
    });

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(stored.slice(0, 2), original);
    assert.equal(stored.length, 3);
    assert.equal(stored[2]?.role, 'compaction');
    const history = buildCompactionAwareHistory(stored, threadId);
    assert.equal(history[0]?.kind, 'user');
    if (history[0]?.kind === 'user') {
      assert.match(history[0].text, /summary/u);
    }
    assert.deepEqual(history.slice(1), [
      { kind: 'assistant', phase: 'final_answer', text: 'kept' },
    ]);
  });
});

void test('provider summary compaction replaces older history and retains the active user turn', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'older request');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'older answer');
    const current = await appendMessage(
      workspaceRoot,
      threadId,
      'user',
      'current request',
    );
    const result = await compactThreadContextSummary({
      workspaceRoot,
      threadId,
      history: [
        { kind: 'user', text: 'older request' },
        {
          kind: 'assistant',
          phase: 'final_answer',
          text: 'older answer',
        },
        { kind: 'user', text: 'current request' },
      ],
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: {
        countHistoryTokens(history) {
          const last = history.at(-1);
          assert.deepEqual(last, {
            kind: 'user',
            text: 'current request',
          });
          return history.length === 1 ? 30 : 40;
        },
      },
      summarizer: {
        async summarizeContext(request) {
          assert.deepEqual(request.historyPrefix, [
            { kind: 'user', text: 'older request' },
            {
              kind: 'assistant',
              phase: 'final_answer',
              text: 'older answer',
            },
          ]);
          return {
            summary: 'Older work was completed.',
            shortSummary: 'Older work completed.',
            summaryTokens: 10,
          };
        },
      },
    });

    assert.equal(result.kind, 'compacted');
    if (result.kind !== 'compacted') {
      assert.fail('expected provider summary compaction');
    }
    assert.equal(result.providerRoundAnchorEntryId, current.entryId);
    const history = buildCompactionAwareHistory(
      await readTranscriptEntries(workspaceRoot, threadId),
      threadId,
    );
    assert.equal(history[0]?.kind, 'user');
    if (history[0]?.kind === 'user') {
      assert.match(history[0].text, /Older work was completed/u);
    }
    assert.deepEqual(history.slice(1), [
      { kind: 'user', text: 'current request' },
    ]);
  });
});

void test('the summarizer receives the previous checkpoint summary on recompaction', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const firstKept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'first kept',
    );
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'compaction',
      content: '',
      timestamp: TEST_TIMESTAMP,
      compactionData: {
        summary: 'previous summary',
        shortSummary: 'previous',
        firstKeptEntryId: firstKept.entryId,
        tokensBefore: TEST_BUDGET_PROFILE.thresholdTokens,
        budgetProfile: TEST_BUDGET_PROFILE,
      },
    });
    const latest = await appendMessage(
      workspaceRoot,
      threadId,
      'user',
      'latest',
    );
    let receivedPreviousSummary: string | undefined;

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 100],
        [firstKept.entryId, 60],
        [latest.entryId, 40],
      ]),
      summarizer: {
        async summarizeContext(request) {
          receivedPreviousSummary = request.previousSummary;
          return {
            summary: 'replacement summary',
            shortSummary: 'replacement',
            summaryTokens: 15,
          };
        },
      },
      forced: false,
    });

    assert.equal(result.kind, 'compacted');
    assert.equal(receivedPreviousSummary, 'previous summary');
  });
});

void test('a transcript append during summarization returns stale_snapshot without a checkpoint', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const summarizer: ContextCompactionSummarizer = {
      async summarizeContext() {
        await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
        return {
          summary: 'summary',
          shortSummary: 'short',
          summaryTokens: 10,
        };
      },
    };

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      summarizer,
      forced: false,
    });

    assert.equal(result.kind, 'stale_snapshot');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'assistant', 'user'],
    );
  });
});

void test('an invalid or failed summary leaves the transcript unchanged', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const before = await readTranscriptEntries(workspaceRoot, threadId);
    const common = {
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      forced: false,
    } as const;

    const invalid = await compactThreadContext({
      ...common,
      summarizer: summaryReturning(
        'summary',
        'short',
        TEST_BUDGET_PROFILE.summaryBudgetTokens + 1,
      ),
    });
    assert.deepEqual(invalid, {
      kind: 'summary_invalid',
      reason: 'summary_exceeds_budget',
    });
    await assert.rejects(
      compactThreadContext({
        ...common,
        summarizer: {
          async summarizeContext() {
            throw new Error('provider unavailable');
          },
        },
      }),
      /provider unavailable/u,
    );
    assert.deepEqual(
      await readTranscriptEntries(workspaceRoot, threadId),
      before,
    );
  });
});

void test('provider transition appends a readable checkpoint without rewriting raw transcript entries', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old question');
    const covered = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'old answer',
    );
    const retained = await appendMessage(
      workspaceRoot,
      threadId,
      'user',
      'exact current question',
    );
    const original = await readTranscriptEntries(workspaceRoot, threadId);

    const result = await compactThreadContextForProviderTransition({
      workspaceRoot,
      threadId,
      sourceProviderId: 'grok_oauth',
      sourceModel: 'grok-4.5',
      targetProviderId: 'openai_codex_direct',
      targetModel: 'gpt-5.6-sol',
      summarizer: {
        async summarizeContext(request) {
          assert.equal(request.coveredThroughEntryId, covered.entryId);
          assert.equal(request.firstKeptEntryId, retained.entryId);
          return { summary: 'portable handoff', inputTokens: 300_000 };
        },
      },
      now: () => new Date(TEST_TIMESTAMP),
    });

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(stored.slice(0, original.length), original);
    assert.equal(stored.length, original.length + 1);
    const checkpoint = stored.at(-1);
    assert.equal(checkpoint?.role, 'compaction');
    if (
      checkpoint?.role === 'compaction' &&
      isProviderNativeCompactionEntryData(checkpoint.compactionData)
    ) {
      assert.deepEqual(checkpoint.compactionData, {
        kind: 'provider_transition',
        sourceProviderId: 'grok_oauth',
        sourceModel: 'grok-4.5',
        targetProviderId: 'openai_codex_direct',
        targetModel: 'gpt-5.6-sol',
        summary: 'portable handoff',
        coveredThroughEntryId: covered.entryId,
        firstKeptEntryId: retained.entryId,
        inputTokens: 300_000,
      });
    }
  });
});

void test('provider transition refuses a stale snapshot and leaves raw entries intact', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old question');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'old answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'current question');

    const result = await compactThreadContextForProviderTransition({
      workspaceRoot,
      threadId,
      sourceProviderId: 'grok_oauth',
      sourceModel: 'grok-4.5',
      targetProviderId: 'openai_codex_direct',
      targetModel: 'gpt-5.6-sol',
      summarizer: {
        async summarizeContext() {
          await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
          return { summary: 'stale handoff' };
        },
      },
    });

    assert.equal(result.kind, 'stale_snapshot');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'assistant', 'user', 'user'],
    );
  });
});

void test('provider-native compaction appends a projection-first checkpoint and retains the active user tail verbatim', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'continue');
    const original = await readTranscriptEntries(workspaceRoot, threadId);
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
      { kind: 'user', text: 'continue' },
    ];

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
      now: () => new Date(TEST_TIMESTAMP),
    });
    assert.equal(changedPolicy.kind, 'compacted');
    assert.equal(repeatedCompactCalls, 1);
  });
});

void test('provider-native compaction leaves in-memory history untouched when transcript CAS loses a race', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'continue');
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
      { kind: 'user', text: 'continue' },
    ];
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
  });
});

void test('provider-native compaction exposes only projected evidence metadata and records explicitly expanded pages without their content', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const decoyOutputRef = `tool-output:${threadId}/run-read/call-decoy`;
    const outputRef = `tool-output:${threadId}/run-search/call-search`;
    const commandOutputRef = `command-output:${encodeURIComponent(threadId)}/00000000-0000-4000-8000-000000000401`;
    await appendMessage(workspaceRoot, threadId, 'user', 'find the owner');
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-decoy',
        tool: 'read_file',
        args: { path: 'decoy.txt' },
      }),
      timestamp: TEST_TIMESTAMP,
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-decoy',
        output: JSON.stringify({
          ok: true,
          offloaded: true,
          tool: 'read_file',
          callId: 'call-decoy',
          outputRef: decoyOutputRef,
          fullOutputBytes: 32_000,
          summary: 'read_file returned a decoy.',
        }),
      }),
      timestamp: TEST_TIMESTAMP,
    });
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
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        callId: 'call-command',
        tool: 'exec_command',
        args: { cmd: 'long-running-command' },
      }),
      timestamp: TEST_TIMESTAMP,
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-command',
        output: JSON.stringify({
          status: 'exit',
          outputRef: commandOutputRef,
          stdoutBytes: 120,
          stderrBytes: 4,
        }),
      }),
      timestamp: TEST_TIMESTAMP,
    });
    await appendMessage(workspaceRoot, threadId, 'user', 'use that evidence');
    const history: HistoryItem[] = [
      { kind: 'user', text: 'find the owner' },
      {
        kind: 'function_call',
        id: 'fc-decoy',
        callId: 'call-decoy',
        name: 'read_file',
        arguments: '{"path":"decoy.txt"}',
      },
      {
        kind: 'backend_item',
        data: {
          type: 'function_call',
          id: 'fc-decoy-native',
          call_id: 'call-decoy',
          name: 'read_file',
          arguments: '{"path":"decoy.txt"}',
        },
      },
      {
        kind: 'function_call_output',
        callId: 'call-decoy',
        output: JSON.stringify({
          ok: true,
          offloaded: true,
          tool: 'read_file',
          callId: 'call-decoy',
          outputRef: decoyOutputRef,
          fullOutputBytes: 32_000,
          summary: 'read_file returned a decoy.',
        }),
      },
      {
        kind: 'backend_item',
        data: {
          type: 'function_call',
          id: 'fc-search-native',
          call_id: 'call-search',
          name: 'search_files',
          arguments: '{"query":"owner"}',
        },
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
      {
        kind: 'function_call',
        id: 'fc-command',
        callId: 'call-command',
        name: 'exec_command',
        arguments: '{"cmd":"long-running-command"}',
      },
      {
        kind: 'function_call_output',
        callId: 'call-command',
        output: JSON.stringify({
          status: 'exit',
          outputRef: commandOutputRef,
          stdoutBytes: 120,
          stderrBytes: 4,
        }),
      },
      { kind: 'user', text: 'use that evidence' },
    ];
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
            callId: 'call-decoy',
            toolName: 'read_file',
            outcome: 'success',
            fullOutputBytes: 32_000,
            outputRef: decoyOutputRef,
          },
          {
            callId: 'call-search',
            toolName: 'search_files',
            outcome: 'success',
            fullOutputBytes: 64_000,
            outputRef,
          },
          {
            callId: 'call-command',
            toolName: 'exec_command',
            outcome: 'unknown',
            fullOutputBytes: 124,
            outputRef: commandOutputRef,
          },
        ]);
        assert.deepEqual(retainedHistory, [
          { kind: 'user', text: 'use that evidence' },
        ]);
        assert.deepEqual(
          selectEvidence({
            callId: 'call-decoy',
            toolName: 'read_file',
            arguments: '{"path":"decoy.txt"}',
          }),
          {
            kind: 'failed',
            reason: 'target_call_ambiguous',
          },
        );
        assert.deepEqual(
          selectEvidence({
            callId: 'call-search',
            toolName: 'search_files',
            arguments: '{"query":"owner"}',
          }),
          {
            kind: 'selected',
            evidence: evidence[1],
          },
        );
        assert.deepEqual(
          selectEvidence({
            callId: 'call-search',
            toolName: 'search_files',
            arguments: '{"query":"different"}',
          }),
          {
            kind: 'failed',
            reason: 'target_call_identity_mismatch',
          },
        );
        assert.deepEqual(
          selectEvidence({
            callId: 'call-missing',
            toolName: 'search_files',
            arguments: '{"query":"owner"}',
          }),
          { kind: 'failed', reason: 'target_call_not_found' },
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
        assert.equal(historyPrefix.length, 8);
        assert.equal(evidence[1]?.outputRef, outputRef);
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
          callId: 'call-decoy',
          toolName: 'read_file',
          outcome: 'success',
          fullOutputBytes: 32_000,
          outputRef: decoyOutputRef,
        },
        {
          callId: 'call-search',
          toolName: 'search_files',
          outcome: 'success',
          fullOutputBytes: 64_000,
          outputRef,
        },
        {
          callId: 'call-command',
          toolName: 'exec_command',
          outcome: 'unknown',
          fullOutputBytes: 124,
          outputRef: commandOutputRef,
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
  });
});

void test('provider-native compaction fails without mutation when evidence selection or recovery is unavailable', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'continue');
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
      { kind: 'user', text: 'continue' },
    ];
    const before = structuredClone(history);
    let compactCalls = 0;

    const selectionResult = await compactThreadContextNative({
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

    assert.deepEqual(selectionResult, {
      kind: 'evidence_recovery_failed',
      reason: 'selection_unavailable',
    });

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
    assert.equal(
      (await readTranscriptEntries(workspaceRoot, threadId)).some(
        (entry) => entry.role === 'compaction',
      ),
      false,
    );
  });
});

void test('provider-native compaction rejects invalid output and suppresses a repeated ineffective boundary', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    await appendMessage(workspaceRoot, threadId, 'user', 'continue');
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
      { kind: 'user', text: 'continue' },
    ];

    const invalid = await compactThreadContextNative({
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
    assert.deepEqual(invalid, { kind: 'provider_output_invalid' });

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
    assert.equal(
      (await readTranscriptEntries(workspaceRoot, threadId)).some(
        (entry) => entry.role === 'compaction',
      ),
      false,
    );
  });
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

function tokenCounter(
  counts: ReadonlyArray<readonly [string, number]>,
): ContextCompactionTokenCounter {
  const countsByEntryId = new Map(counts);
  return {
    countTranscriptEntryTokens(entry) {
      return countsByEntryId.get(entry.entryId) ?? 1;
    },
  };
}

function summaryReturning(
  summary: string,
  shortSummary: string,
  summaryTokens: number,
): ContextCompactionSummarizer {
  return {
    async summarizeContext() {
      return { summary, shortSummary, summaryTokens };
    },
  };
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
    join(tmpdir(), 'geulbat-compaction-run-'),
  );
  try {
    await run({ workspaceRoot, threadId: testThreadId(91) });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
