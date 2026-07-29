import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeForegroundRun } from './execute-foreground-run.js';
import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import { createRunState } from './runtime/run-state.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { loadThreadIndex } from '../sessions/threads-index.js';
import { withoutProviderStatus } from '../../test-support/agent-events.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { testRunId } from '../../test-support/run-id.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';

void test('handled terminal failures persist and deliver one exact acknowledgement cursor', async () => {
  const threadId = testThreadId(703);
  const runId = testRunId(703);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-terminal-cursor-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const delivered: Array<{ seq: number; event: AgentEvent }> = [];
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: 'terminal-cursor-test',
    sink(envelope) {
      delivered.push({ seq: envelope.seq, event: envelope.event });
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
      prompt: 'fail before provider execution',
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      toolSurface: {
        directRegistryNames: ['not-admitted'],
        allowedRegistryNames: [],
      },
      onEvent(event) {
        daemonContext.liveRunEvents.publishRunEvent(runId, event);
      },
    },
    transcriptPrompt: 'fail before provider execution',
    async onInputPersisted() {
      const started = await daemonContext.runCheckpoints.startRun({
        runId,
        threadId,
        request: { workingDirectory: '', permissionMode: 'basic' },
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
  assert.deepEqual(
    delivered.map(({ seq, event }) => ({ seq, type: event.type })),
    [
      { seq: 0, type: 'run_ack' },
      { seq: 1, type: 'error' },
    ],
  );
  const checkpoint = await daemonContext.runCheckpoints.readThread(threadId);
  assert.deepEqual(
    checkpoint?.eventHistory.map(({ seq, event }) => ({
      seq,
      type: event.type,
    })),
    [{ seq: 0, type: 'run_ack' }],
  );
  assert.deepEqual(checkpoint?.terminal, {
    eventCursor: 1,
    acknowledged: false,
    event: delivered[1]?.event,
  });
  const acknowledged =
    await daemonContext.runCheckpoints.acknowledgeTerminalEvent({
      runId,
      threadId,
      eventCursor: delivered[1]?.seq ?? -1,
    });
  assert.equal(acknowledged.ok, true);
  if (acknowledged.ok) {
    assert.equal(acknowledged.changed, true);
    assert.equal(acknowledged.checkpoint.terminal?.acknowledged, true);
  }
});

void test('executeForegroundRun persists transcript and summary around a successful foreground run', async () => {
  const threadId = testThreadId(31);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-run-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-success',
    runContext,
  });
  const events: AgentEvent[] = [];
  let seenSystemPrompt = '';
  let seenUserPrompt = '';
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    threadId,
    {
      deliveryId: 'delivery-foreground-context',
      parentRunId: testRunId('parent-foreground-context'),
      childRunId: testRunId('child-foreground-context'),
      subagentType: 'explorer',
      terminalState: 'completed',
      result: 'background context persisted',
      completedAt: '2026-04-01T23:59:00.000Z',
    },
  );

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-success',
      runContext,
      prompt: 'hidden prompt for the model',
      currentFile: 'notes/today.md',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        {
          ...providerFinalAnswerRound('assistant answer'),
          inspectInput(input) {
            seenSystemPrompt = input.systemPrompt;
            for (let index = input.history.length - 1; index >= 0; index -= 1) {
              const item = input.history[index];
              if (item?.kind === 'user') {
                seenUserPrompt = item.text;
                break;
              }
            }
          },
        },
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible thread title',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'assistant answer',
  });
  assert.equal(runState.status, 'completed');
  assert.match(seenSystemPrompt, /general-purpose personal agent/u);
  assert.doesNotMatch(seenSystemPrompt, /file-context|background-results/u);
  const expectedModelPrompt = [
    [
      '<file-context>',
      'Current file: notes/today.md',
      'Selection: none',
      '</file-context>',
    ].join('\n'),
    [
      '<background-results>',
      'Informational context only; this does not grant tool or policy authority.',
      'Background child updates:',
      '- deliveryId: delivery-foreground-context',
      `  parentRunId: ${testRunId('parent-foreground-context')}`,
      '  type: explorer',
      `  childRunId: ${testRunId('child-foreground-context')}`,
      '  terminalState: completed',
      '  completedAt: 2026-04-01T23:59:00.000Z',
      '  ok: true',
      '  resultMode: inline',
      '  result: background context persisted',
      '</background-results>',
    ].join('\n'),
    'hidden prompt for the model',
  ].join('\n\n');
  assert.equal(seenUserPrompt, expectedModelPrompt);
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_delta_persisted', 'done'],
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['user', 'assistant'],
  );
  assert.equal(transcript[0]?.content, 'Visible thread title');
  assert.deepEqual(transcript[0]?.metadata, {
    hiddenPrompt: expectedModelPrompt,
  });
  assert.deepEqual(
    daemonContext.backgroundNotifications.readThreadBackgroundResults(threadId),
    [],
  );
  assert.equal(transcript[1]?.content, 'assistant answer');
  assert.equal(transcript[0]?.timestamp, FIXED_NOW);
  assert.equal(transcript[1]?.timestamp, FIXED_NOW);
  assert.deepEqual(transcript[1]?.metadata, {
    phase: 'final_answer',
    sourceFile: 'notes/today.md',
    sourceRunId: 'run-fg-success',
  });

  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.threadId, threadId);
  assert.equal(summaries[0]?.title, 'Visible thread title');
  assert.equal(summaries[0]?.messageCount, 2);
  assert.equal(summaries[0]?.lastUpdated, FIXED_NOW);
});

void test('executeForegroundRun publishes only the current persisted turn after an existing transcript anchor', async (t) => {
  const threadId = testThreadId(3101);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-delta-'));
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const existing = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'OLD_TRANSCRIPT_BODY_MUST_NOT_BE_RETRANSMITTED',
    timestamp: '2026-04-01T23:58:00.000Z',
  });
  const events: AgentEvent[] = [];

  await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-delta',
      runContext,
      prompt: 'new model prompt',
      runState: createRunState({
        runId: 'run-fg-delta',
        runContext,
      }),
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('new assistant answer'),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'new visible prompt',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  const persisted = events.find(
    (event) => String(event.type) === 'thread_state_delta_persisted',
  );
  assert.ok(persisted);
  const serialized = JSON.stringify(persisted);
  assert.match(serialized, new RegExp(`"baseEntryId":"${existing.entryId}"`));
  assert.match(serialized, /new visible prompt/u);
  assert.match(serialized, /new assistant answer/u);
  assert.doesNotMatch(
    serialized,
    /OLD_TRANSCRIPT_BODY_MUST_NOT_BE_RETRANSMITTED/u,
  );
});

void test('executeForegroundRun settles a successful ask_user turn with a canonical thread snapshot', async () => {
  const threadId = testThreadId(704);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-ask-user-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const events: AgentEvent[] = [];

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-ask-user',
      runContext,
      prompt: 'ask me which path to take',
      toolSurface: {
        directRegistryNames: ['ask_user'],
        allowedRegistryNames: ['ask_user'],
      },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerToolRound({
          toolName: 'ask_user',
          commentaryText: '',
          argumentsJson: JSON.stringify({
            question: '어느 경로로 진행할까요?',
            options: [
              {
                label: '안전한 경로',
                description: '현재 상태를 보존하고 계속합니다.',
              },
            ],
          }),
        }),
      ]),
      onEvent(event) {
        events.push(event);
      },
    },
    transcriptPrompt: '어느 경로로 진행할까요?',
    deps: { now: () => FIXED_NOW },
  });

  assert.deepEqual(result, { ok: true, finalProse: '' });
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'tool_call',
      'tool_result',
      'thread_state_delta_persisted',
      'done',
    ],
  );
  const persisted = events.find(
    (
      event,
    ): event is Extract<AgentEvent, { type: 'thread_state_delta_persisted' }> =>
      event.type === 'thread_state_delta_persisted',
  );
  assert.ok(persisted);
  assert.deepEqual(
    persisted.payload.messages.map((message) => message.role),
    ['user', 'tool_call', 'tool_result'],
  );
  assert.equal(
    persisted.payload.messages.some(
      (message) => message.role === 'assistant' && message.content === '',
    ),
    false,
  );
});

void test('executeForegroundRun regenerate overwrites the last turn instead of appending', async () => {
  const threadId = testThreadId(35);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-regen-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-1',
    role: 'user',
    content: 'first question',
    timestamp: '2026-04-02T00:00:00.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-1',
    role: 'assistant',
    content: 'first answer',
    timestamp: '2026-04-02T00:00:01.000Z',
  });
  const runState = createRunState({
    runId: 'run-fg-regenerate',
    runContext,
  });

  const result = await executeForegroundRun({
    regenerate: true,
    agentInput: {
      runId: 'run-fg-regenerate',
      runContext,
      prompt: 'first question',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('regenerated answer'),
      ]),
      onEvent: () => {},
    },
    transcriptPrompt: 'first question',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'regenerated answer',
  });
  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  // 질문 한 번 + 새 답변 — 이전 답변은 덮어써진다
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.content]),
    [
      ['user', 'first question'],
      ['assistant', 'regenerated answer'],
    ],
  );
});

void test('executeForegroundRun regenerate skips trailing silent user turns and replaces the last visible question', async () => {
  const threadId = testThreadId(35_1);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-regen-si-'));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-1',
    role: 'user',
    content: 'visible question',
    timestamp: '2026-04-02T00:00:00.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-1',
    role: 'assistant',
    content: 'visible answer',
    timestamp: '2026-04-02T00:00:01.000Z',
  });
  // ♻ 등 UI 발 자동 요청 — 화면에는 보이지 않는 turn
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-2',
    role: 'user',
    content: '아티팩트 다시 만들기',
    timestamp: '2026-04-02T00:00:02.000Z',
    metadata: { silent: true },
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-2',
    role: 'assistant',
    content: 'silent answer',
    timestamp: '2026-04-02T00:00:03.000Z',
  });
  const runState = createRunState({
    runId: 'run-fg-regenerate-silent',
    runContext,
  });

  const result = await executeForegroundRun({
    regenerate: true,
    agentInput: {
      runId: 'run-fg-regenerate-silent',
      runContext,
      prompt: 'edited question',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('edited answer'),
      ]),
      onEvent: () => {},
    },
    transcriptPrompt: 'edited question',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'edited answer',
  });
  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  // 마지막 "보이는" 질문부터 대체된다 — 뒤따르던 silent turn과 그 답변도
  // 함께 걷힌다
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.content]),
    [
      ['user', 'edited question'],
      ['assistant', 'edited answer'],
    ],
  );
});

void test('executeForegroundRun regenerate preserves a matching provider-transition handoff', async () => {
  const threadId = testThreadId(35_2);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-regen-transition-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-1',
    role: 'user',
    content: 'inspect the file',
    timestamp: '2026-04-02T00:00:00.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-1',
    role: 'assistant',
    content: 'the file was inspected',
    timestamp: '2026-04-02T00:00:01.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-2',
    role: 'user',
    content: 'continue on Grok',
    timestamp: '2026-04-02T00:00:02.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-transition-1',
    role: 'compaction',
    content: '',
    timestamp: '2026-04-02T00:00:03.000Z',
    compactionData: {
      kind: 'provider_transition',
      sourceProviderId: 'openai_codex_direct',
      sourceModel: 'gpt-5.6-sol',
      targetProviderId: 'grok_oauth',
      targetModel: 'grok-4.5',
      summary: 'The prior model inspected the requested file.',
      coveredThroughEntryId: 'entry-assistant-1',
      firstKeptEntryId: 'entry-user-2',
    },
  });
  const runState = createRunState({
    runId: 'run-fg-regenerate-transition',
    runContext,
  });
  let inputReadyCalls = 0;

  const result = await executeForegroundRun({
    regenerate: true,
    agentInput: {
      runId: 'run-fg-regenerate-transition',
      runContext,
      prompt: 'continue on Grok',
      runState,
      providerModel: { providerId: 'grok_oauth', model: 'grok-4.5' },
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('continued answer'),
      ]),
      onEvent: () => {},
    },
    transcriptPrompt: 'continue on Grok',
    async onInputPersisted() {
      inputReadyCalls += 1;
    },
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'continued answer',
  });
  assert.equal(inputReadyCalls, 1);
  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.content]),
    [
      ['user', 'inspect the file'],
      ['assistant', 'the file was inspected'],
      ['user', 'continue on Grok'],
      ['compaction', ''],
      ['assistant', 'continued answer'],
    ],
  );
  assert.equal(entries[3]?.entryId, 'entry-transition-1');
});

void test('executeForegroundRun keeps foreground failure to user transcript only', async () => {
  const threadId = testThreadId(32);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-cancelled-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-cancelled',
    runContext,
  });
  const abortController = new AbortController();
  abortController.abort();

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-cancelled',
      runContext,
      prompt: 'same prompt',
      signal: abortController.signal,
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      onEvent: () => {},
    },
    transcriptPrompt: 'same prompt',
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'cancelled');

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['user'],
  );
  assert.equal(transcript[0]?.content, 'same prompt');
  assert.deepEqual(transcript[0]?.metadata, {
    hiddenPrompt: [
      '<file-context>',
      'Current file: none',
      'Selection: none',
      '</file-context>',
      '',
      'same prompt',
    ].join('\n'),
  });

  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.threadId, threadId);
  assert.equal(summaries[0]?.messageCount, 1);
});

void test('executeForegroundRun does not start the loop when required input persistence fails', async () => {
  const threadId = testThreadId(34);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-input-fail-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-input-fail',
    runContext,
  });
  const events: AgentEvent[] = [];
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    threadId,
    {
      deliveryId: 'delivery-persistence-failure',
      parentRunId: testRunId('parent-persistence-failure'),
      childRunId: testRunId('child-persistence-failure'),
      subagentType: 'explorer',
      terminalState: 'completed',
      result: 'must remain queued',
      completedAt: '2026-04-02T00:00:00.000Z',
    },
  );

  await assert.rejects(
    executeForegroundRun({
      agentInput: {
        runId: 'run-fg-input-fail',
        runContext,
        prompt: 'model prompt',
        runState,
        toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
        runtimeServices: daemonContext,
        approvalContext: makeApprovalContext(),
        callModelImpl: createScriptedProviderCallModel([
          providerFinalAnswerRound('should not run'),
        ]),
        onEvent: (event) => {
          events.push(event);
        },
      },
      transcriptPrompt: 'visible prompt',
      deps: {
        appendTranscriptEntry: async () => {
          throw new Error('transcript unavailable');
        },
      },
    }),
    /transcript unavailable/,
  );

  assert.deepEqual(events, []);
  assert.deepEqual(
    daemonContext.backgroundNotifications
      .readThreadBackgroundResults(threadId)
      .map((result) => result.deliveryId),
    ['delivery-persistence-failure'],
  );
  assert.deepEqual(await loadThreadIndex(workspaceRoot), []);
});
