import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProviderNativeCompactionEntryData } from '@geulbat/protocol/threads';

import { executeForegroundRun } from './execute-foreground-run.js';
import { createDaemonContext } from '../context.js';
import { createRunState } from './runtime/run-state.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import { compactThreadContextNative } from './memory/compaction-run.js';
import { loadExistingHistory, loadInitialHistory } from './loop-history.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';

void test('executeForegroundRun persists provider-native checkpoint before the new assistant tail and rebuilds it after restart', async () => {
  const threadId = testThreadId(35);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-native-compaction-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const summarizedContext = 'older provider context '.repeat(200);
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: summarizedContext,
    timestamp: '2026-07-17T00:00:00.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: summarizedContext,
    timestamp: '2026-07-17T00:00:01.000Z',
  });
  const finalRound = providerFinalAnswerRound('assistant tail');
  const memoryPort = createAgentLoopMemoryPort({
    resolvePolicy: async () => ({
      providerId: 'openai_codex_direct',
      model: daemonContext.provider.requestOptions.model,
      contextWindow: 100,
      thresholdTokens: 90,
      supportsParallelToolCalls: true,
    }),
    compactHistory: async (input) => {
      assert.deepEqual(
        input.history.map((item) => item.kind),
        ['user', 'assistant'],
      );
      assert.ok(input.providerReplayScopeId);
      return {
        providerReplayScopeId: input.providerReplayScopeId,
        output: [
          {
            type: 'compaction',
            encrypted_content: 'opaque-checkpoint',
          },
        ],
      };
    },
    compactThread: compactThreadContextNative,
  });

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-native-compaction',
      runContext,
      prompt: 'compact this thread',
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      memoryPort,
      callModelImpl: createScriptedProviderCallModel([
        {
          ...finalRound,
          events: [
            ...(finalRound.events ?? []),
            {
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: 90,
                  output_tokens: 4,
                },
              },
            },
          ],
        },
      ]),
      onEvent: () => undefined,
    },
    transcriptPrompt: 'compact this thread',
    deps: { now: () => FIXED_NOW },
  });

  assert.deepEqual(result, { ok: true, finalProse: 'assistant tail' });
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['user', 'assistant', 'user', 'compaction', 'assistant'],
  );
  const compaction = transcript[3];
  assert.equal(compaction?.role, 'compaction');
  if (
    compaction?.role !== 'compaction' ||
    !isProviderNativeCompactionEntryData(compaction.compactionData)
  ) {
    return;
  }
  assert.equal(
    compaction.compactionData.coveredThroughEntryId,
    transcript[1]?.entryId,
  );
  assert.equal(
    compaction.compactionData.firstKeptEntryId,
    transcript[2]?.entryId,
  );
  const replayScopeId = compaction.compactionData.replayScopeId;
  assert.ok(replayScopeId);
  const restartedHistory = await loadInitialHistory(
    workspaceRoot,
    threadId,
    'next prompt',
    {
      providerId: 'openai_codex_direct',
      model: daemonContext.provider.requestOptions.model,
      replayScopeId,
    },
  );
  assert.equal(restartedHistory[0]?.kind, 'provider_native_compaction');
  const retainedPrompt = restartedHistory[1];
  assert.equal(retainedPrompt?.kind, 'user');
  if (retainedPrompt?.kind === 'user') {
    assert.match(retainedPrompt.text, /compact this thread$/u);
  }
  assert.deepEqual(restartedHistory.slice(2), [
    {
      kind: 'backend_item',
      data: {
        id: 'msg_1',
        type: 'message',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'assistant tail' }],
      },
      providerReplayScopeId: replayScopeId,
    },
    { kind: 'user', text: 'next prompt' },
  ]);
});

void test('executeForegroundRun logs run lifecycle with run and thread identity', async () => {
  const threadId = testThreadId(34);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-run-logs-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-logs',
    runContext,
  });
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    const result = await executeForegroundRun({
      agentInput: {
        runId: 'run-fg-logs',
        runContext,
        prompt: 'prompt',
        runState,
        toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
        runtimeServices: daemonContext,
        approvalContext: makeApprovalContext(),
        callModelImpl: createScriptedProviderCallModel([
          providerFinalAnswerRound('assistant answer'),
        ]),
        onEvent: () => {},
      },
      transcriptPrompt: 'Visible title',
    });

    assert.deepEqual(result, {
      ok: true,
      finalProse: 'assistant answer',
    });
  } finally {
    console.log = originalLog;
  }

  const agentLogs = logs.filter((entry) =>
    String(entry[0] ?? '').includes('[agent/execute-foreground-run]'),
  );
  assert.equal(agentLogs.length, 2);
  assert.match(
    String(agentLogs[0]?.[0] ?? ''),
    /info \[agent\/execute-foreground-run\] run started/,
  );
  assert.doesNotMatch(String(agentLogs[0]?.[0] ?? ''), /projectId=/);
  assert.match(String(agentLogs[0]?.[0] ?? ''), /runId="run-fg-logs"/);
  assert.match(
    String(agentLogs[0]?.[0] ?? ''),
    new RegExp(`threadId="${threadId}"`),
  );
  assert.equal(agentLogs[0]?.length, 1);
  assert.match(
    String(agentLogs[1]?.[0] ?? ''),
    /info \[agent\/execute-foreground-run\] run completed/,
  );
  assert.match(String(agentLogs[1]?.[0] ?? ''), /runId="run-fg-logs"/);
  assert.equal(
    typeof (agentLogs[1]?.[1] as { durationMs?: unknown })?.durationMs,
    'number',
  );
  assert.equal((agentLogs[1]?.[1] as { ok?: unknown })?.ok, true);
});

void test('executeForegroundRun resumes a persisted turn without appending the user prompt again', async () => {
  const threadId = testThreadId(37);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-resume-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const modelPrompt = 'exact persisted model prompt';
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'visible persisted prompt',
    metadata: { hiddenPrompt: modelPrompt },
    timestamp: FIXED_NOW,
  });
  let inputPersistenceCalled = false;
  let seenUserCount = 0;

  await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-resume',
      runContext,
      prompt: modelPrompt,
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      historyPort: {
        async loadInitialHistory(args) {
          return await loadExistingHistory(
            args.workspaceRoot,
            args.threadId,
            args.providerTarget,
          );
        },
      },
      callModelImpl: createScriptedProviderCallModel([
        {
          ...providerFinalAnswerRound('resumed answer'),
          inspectInput(input) {
            seenUserCount = input.history.filter(
              (item) => item.kind === 'user',
            ).length;
          },
        },
      ]),
      onEvent() {},
    },
    transcriptPrompt: 'visible persisted prompt',
    resumeModelPrompt: modelPrompt,
    async onInputPersisted() {
      inputPersistenceCalled = true;
    },
  });

  assert.equal(inputPersistenceCalled, false);
  assert.equal(seenUserCount, 1);
  assert.equal(
    (await readTranscriptEntries(workspaceRoot, threadId)).filter(
      (entry) => entry.role === 'user',
    ).length,
    1,
  );
});
