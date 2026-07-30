import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProviderNativeCompactionEntryData } from '@geulbat/protocol/threads';

import { executeForegroundRun } from './execute-foreground-run.js';
import { createDaemonContext } from '../context.js';
import { callModelWithDependencies } from '../llm/provider/client.js';
import { resolveProviderRequestOptions } from '../llm/provider/provider-options.js';
import { createRunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import type { LiveRunEventEnvelope } from '../sessions/live-run-events.js';
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
import { testRunId } from '../../test-support/run-id.js';
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

void test('executeForegroundRun correlates durable 429 evidence with its provider session and model after reload', async (t) => {
  const threadId = testThreadId(36);
  const runId = testRunId('provider-rate-limit-correlation');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-provider-rate-limit-'),
  );
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const defaultProviderRequestOptions = resolveProviderRequestOptions({});
  const daemonContext = createDaemonContext({
    homeStateRoot: workspaceRoot,
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      modelRoundRetry: {
        ...defaultProviderRequestOptions.modelRoundRetry,
        llmRateLimited: { maxRetries: 0 },
      },
    },
  });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const providerModel = {
    providerId: 'openai_codex_direct',
    model: 'gpt-5.6-sol',
  } as const;
  const providerRequestIdentity = 'c'.repeat(64);
  const delivered: LiveRunEventEnvelope[] = [];

  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: 'provider-rate-limit-correlation-test',
    sink(envelope) {
      delivered.push(envelope);
      return true;
    },
    async persistRunEvents(events) {
      await daemonContext.runCheckpoints.appendRunEvents({
        threadId,
        runId,
        events,
      });
    },
  });

  const result = await executeForegroundRun({
    agentInput: {
      runId,
      runContext,
      prompt: 'exercise one durable provider rate limit',
      providerModel,
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      callModelImpl(input) {
        assert.equal(input.providerSessionId, threadId);
        assert.deepEqual(
          {
            providerId: input.providerRequestOptions.providerId,
            model: input.providerRequestOptions.model,
          },
          providerModel,
        );
        return callModelWithDependencies(input, {
          getProviderAuth: async () => ({
            accessToken: 'test-access-token',
            accountId: 'test-account',
          }),
          forceRefreshProviderAuth: async () => ({
            accessToken: 'test-access-token',
            accountId: 'test-account',
          }),
          async streamResponsesOverWebSocket(request) {
            assert.equal(request.providerSessionId, threadId);
            await request.onDurableRequestPrepared?.({
              requestIdentity: providerRequestIdentity,
              providerRequestAttempt: 0,
              transportKind: 'websocket',
              resumed: false,
            });
            throw Object.assign(new Error('too many requests'), {
              status: 429,
              retryAfterMs: 2_500,
            });
          },
        });
      },
      onEvent(event) {
        daemonContext.liveRunEvents.publishRunEvent(runId, event);
      },
    },
    transcriptPrompt: 'exercise one durable provider rate limit',
    async onInputPersisted() {
      const started = await daemonContext.runCheckpoints.startRun({
        runId,
        threadId,
        request: {
          permissionMode: 'basic',
          providerModel,
        },
      });
      assert.equal(started.ok, true);
    },
    async onTerminalEvent({ event }) {
      await daemonContext.liveRunEvents.commitTerminalRunEvent({
        runId,
        event,
        async persist(envelope) {
          await daemonContext.runCheckpoints.settleRun({
            runId,
            threadId,
            terminal: {
              eventCursor: envelope.seq,
              event: envelope.event,
            },
          });
        },
      });
    },
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  const checkpoint = await createRunCheckpointStore({
    stateRoot: workspaceRoot,
  }).readThread(threadId);
  const durableRateLimitEvent = checkpoint?.eventHistory.find(
    ({ event }) =>
      event.type === 'provider_status' &&
      event.payload.request?.retry?.retryAfterMs === 2_500,
  );
  const liveRateLimitEnvelope = delivered.find(
    (envelope) =>
      envelope.event.type === 'provider_status' &&
      envelope.event.payload.request?.retry?.retryAfterMs === 2_500,
  );
  const activeModelRound = checkpoint?.modelRoundState?.active;

  assert.equal(liveRateLimitEnvelope?.runId, runId);
  assert.equal(liveRateLimitEnvelope?.threadId, threadId);
  assert.equal(
    liveRateLimitEnvelope?.event.type === 'provider_status'
      ? liveRateLimitEnvelope.event.payload.request?.retry?.retryAfterMs
      : undefined,
    2_500,
  );
  assert.equal(checkpoint?.runId, runId);
  assert.equal(checkpoint?.threadId, threadId);
  assert.deepEqual(checkpoint?.request.providerModel, providerModel);
  assert.equal(activeModelRound?.providerId, providerModel.providerId);
  assert.equal(activeModelRound?.model, providerModel.model);
  assert.equal(
    activeModelRound?.providerRequestIdentity,
    providerRequestIdentity,
  );
  assert.equal(activeModelRound?.phase, 'terminal_observed');
  assert.equal(
    durableRateLimitEvent?.event.type === 'provider_status'
      ? durableRateLimitEvent.event.payload.request?.retry?.retryAfterMs
      : undefined,
    2_500,
  );
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
