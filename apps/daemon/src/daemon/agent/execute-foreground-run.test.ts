import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef } from '@geulbat/protocol/artifacts';

import { executeForegroundRun } from './execute-foreground-run.js';
import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import { createRunState } from './runtime/run-state.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { threadFilePath } from '../sessions/paths.js';
import {
  loadAllThreadArtifactVersions,
  loadThreadArtifactVersionsByRefs,
} from '../sessions/artifact-store.js';
import { loadThreadIndex } from '../sessions/threads-index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import { compactThreadContextNative } from './memory/compaction-run.js';
import { loadInitialHistory } from './loop-history.js';
import { MID_RUN_STEER_ENABLED_ENV } from './mid-run-steer-flag.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';
const THREAD_STATE_PERSIST_FAILURE_MESSAGE =
  'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.';

function findThreadStatePersistFailedEvent(
  events: AgentEvent[],
): Extract<AgentEvent, { type: 'thread_state_persist_failed' }> {
  const event = events.find(
    (
      candidate,
    ): candidate is Extract<
      AgentEvent,
      { type: 'thread_state_persist_failed' }
    > => candidate.type === 'thread_state_persist_failed',
  );
  assert.ok(event);
  return event;
}

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
      '- type: explorer',
      '  ok: true',
      '  result: background context persisted',
      '</background-results>',
    ].join('\n'),
    'hidden prompt for the model',
  ].join('\n\n');
  assert.equal(seenUserPrompt, expectedModelPrompt);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_persisted', 'done'],
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

void test('executeForegroundRun commits canonical envelope artifacts and stores transcript prose separately', async () => {
  const threadId = testThreadId(35);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-artifact-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-artifact',
    runContext,
  });
  const events: AgentEvent[] = [];
  const answer =
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->';

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-artifact',
      runContext,
      prompt: 'hidden prompt for artifact',
      currentFile: 'episodes/ch01.md',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound(answer),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible artifact title',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: '',
    artifactCandidate: {
      renderer: 'markdown',
      payload: '\n# title\n',
      digest: '요약',
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'artifact_committed', 'thread_state_persisted', 'done'],
  );
  const committedEvent = events[1];
  assert.equal(committedEvent?.type, 'artifact_committed');
  if (committedEvent?.type === 'artifact_committed') {
    assert.equal(committedEvent.payload.artifactId.startsWith('art_'), true);
  }
  const persistedThreadEvent = events[2];
  assert.equal(persistedThreadEvent?.type, 'thread_state_persisted');
  if (persistedThreadEvent?.type === 'thread_state_persisted') {
    assert.equal(persistedThreadEvent.payload.threadId, threadId);
    assert.equal(persistedThreadEvent.payload.messages[1]?.content, '');
    assert.ok(persistedThreadEvent.payload.artifacts);
    assert.equal(
      persistedThreadEvent.payload.artifacts[0]?.renderer,
      'markdown',
    );
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript[1]?.role, 'assistant');
  assert.equal(transcript[1]?.content, '');
  assert.equal(transcript[1]?.metadata?.phase, 'final_answer');
  assert.equal(transcript[1]?.metadata?.sourceFile, 'episodes/ch01.md');
  assert.equal(transcript[1]?.metadata?.sourceRunId, 'run-fg-artifact');
  const ref = transcript[1]?.metadata?.activeArtifactRef as
    | ArtifactRef
    | undefined;
  assert.ok(ref?.artifactId);
  assert.deepEqual(transcript[1]?.metadata?.artifactRefs, [ref]);

  const artifacts = await loadThreadArtifactVersionsByRefs(
    workspaceRoot,
    threadId,
    [ref!],
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.renderer, 'markdown');
  assert.equal(artifacts[0]?.payload, '\n# title\n');
  assert.equal(artifacts[0]?.digest, '요약');
});

void test('executeForegroundRun persists wrapped legacy envelope final text as plain prose', async () => {
  const threadId = testThreadId(36);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-legacy-prose-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-legacy-prose',
    runContext,
  });
  const events: AgentEvent[] = [];
  const answer = [
    'Here is the preview.',
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->',
    '# title',
    '<!-- /GEULBAT_ARTIFACT -->',
    'Use it if helpful.',
  ].join('\n');

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-legacy-prose',
      runContext,
      prompt: 'hidden prompt for legacy prose',
      currentFile: 'episodes/ch02.md',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound(answer),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible legacy prose title',
    deps: {
      now: () => FIXED_NOW,
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: answer,
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_persisted', 'done'],
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript[1]?.role, 'assistant');
  assert.equal(transcript[1]?.content, answer);
  assert.equal(transcript[1]?.metadata?.phase, 'final_answer');
  assert.equal(transcript[1]?.metadata?.sourceFile, 'episodes/ch02.md');
  assert.equal(transcript[1]?.metadata?.sourceRunId, 'run-fg-legacy-prose');
  assert.equal(transcript[1]?.metadata?.activeArtifactRef, undefined);
  assert.equal(transcript[1]?.metadata?.artifactRefs, undefined);
});

void test('executeForegroundRun surfaces malformed assistant transcript persistence without rewriting it as healthy', async () => {
  const threadId = testThreadId(37);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-persist-recover-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-persist-recover',
    runContext,
  });
  const events: AgentEvent[] = [];
  const postRunPersistenceErrors: string[] = [];
  let malformedWrites = 0;

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-persist-recover',
      runContext,
      prompt: 'hidden prompt',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('assistant answer'),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible title',
    deps: {
      appendTranscriptEntry: async (workspace, thread, entry) => {
        if (entry.role === 'assistant') {
          malformedWrites += 1;
          await appendFile(
            threadFilePath(workspace, thread),
            '{"role":"assistant"',
            'utf8',
          );
          throw new Error('partial write');
        }
        return await appendTranscriptEntry(workspace, thread, entry);
      },
      onPostRunPersistenceError: (phase, error) => {
        const message = error instanceof Error ? error.message : String(error);
        postRunPersistenceErrors.push(`${phase}: ${message}`);
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'assistant answer',
  });
  assert.equal(runState.status, 'completed');
  assert.equal(malformedWrites, 1);
  assert.deepEqual(postRunPersistenceErrors, [
    'recover assistant transcript: transcript 00000000-0000-4000-8000-000000000025 has malformed entry at line 2',
    'persist assistant transcript: partial write',
    'update thread summary: transcript 00000000-0000-4000-8000-000000000025 has malformed entry at line 2',
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_persist_failed', 'done'],
  );

  await assert.rejects(
    () => readTranscriptEntries(workspaceRoot, threadId),
    (error: unknown) => {
      assert.equal(
        (error as { name?: unknown }).name,
        'TranscriptCorruptionError',
      );
      assert.equal((error as { code?: unknown }).code, 'transcript_corrupt');
      assert.equal((error as { lineNumber?: unknown }).lineNumber, 2);
      return true;
    },
  );

  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries[0]?.messageCount, 1);
});

void test('executeForegroundRun treats post-run assistant persistence as best-effort', async () => {
  const threadId = testThreadId(33);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-persist-warning-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-best-effort',
    runContext,
  });
  const events: AgentEvent[] = [];
  const postRunPersistenceErrors: string[] = [];

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-best-effort',
      runContext,
      prompt: 'hidden prompt',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('assistant answer'),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible title',
    deps: {
      appendTranscriptEntry: async (workspace, thread, entry) => {
        if (entry.role === 'assistant') {
          throw new Error('disk full');
        }
        return await appendTranscriptEntry(workspace, thread, entry);
      },
      replaceTranscriptEntries: async () => {
        throw new Error('disk full');
      },
      onPostRunPersistenceError: (phase, error) => {
        const message = error instanceof Error ? error.message : String(error);
        postRunPersistenceErrors.push(`${phase}: ${message}`);
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'assistant answer',
  });
  assert.equal(runState.status, 'completed');
  assert.deepEqual(postRunPersistenceErrors, [
    'recover assistant transcript: disk full',
    'persist assistant transcript: disk full',
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_persist_failed', 'done'],
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['user'],
  );

  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.messageCount, 1);
});

void test('executeForegroundRun includes post-run persistence diagnostics without an injected reporter', async () => {
  const threadId = testThreadId(39);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-persist-diagnostics-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-persist-diagnostics',
    runContext,
  });
  const events: AgentEvent[] = [];

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-persist-diagnostics',
      runContext,
      prompt: 'hidden prompt',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('assistant answer'),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible title',
    deps: {
      appendTranscriptEntry: async (workspace, thread, entry) => {
        if (entry.role === 'assistant') {
          throw new Error('disk full');
        }
        return await appendTranscriptEntry(workspace, thread, entry);
      },
      replaceTranscriptEntries: async () => {
        throw new Error('disk full');
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'assistant answer',
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'final_answer_delta', 'thread_state_persist_failed', 'done'],
  );
  assert.deepEqual(findThreadStatePersistFailedEvent(events).payload, {
    message: THREAD_STATE_PERSIST_FAILURE_MESSAGE,
    diagnostics: [
      {
        phase: 'recover assistant transcript',
        message: 'disk full',
      },
      {
        phase: 'persist assistant transcript',
        message: 'disk full',
      },
    ],
  });
});

void test('executeForegroundRun rolls back an artifact when assistant transcript persistence cannot recover', async () => {
  const threadId = testThreadId(38);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-fg-run-artifact-rollback-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-fg-artifact-rollback',
    runContext,
  });
  const events: AgentEvent[] = [];
  const postRunPersistenceErrors: string[] = [];
  const answer =
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# rolled back\n<!-- /GEULBAT_ARTIFACT -->';

  const result = await executeForegroundRun({
    agentInput: {
      runId: 'run-fg-artifact-rollback',
      runContext,
      prompt: 'hidden prompt',
      runState,
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext(),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound(answer),
      ]),
      onEvent: (event) => {
        events.push(event);
      },
    },
    transcriptPrompt: 'Visible title',
    deps: {
      appendTranscriptEntry: async (workspace, thread, entry) => {
        if (entry.role === 'assistant') {
          throw new Error('disk full');
        }
        return await appendTranscriptEntry(workspace, thread, entry);
      },
      replaceTranscriptEntries: async () => {
        throw new Error('disk full');
      },
      onPostRunPersistenceError: (phase, error) => {
        const message = error instanceof Error ? error.message : String(error);
        postRunPersistenceErrors.push(`${phase}: ${message}`);
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: '',
    artifactCandidate: {
      renderer: 'markdown',
      payload: '\n# rolled back\n',
      digest: '요약',
    },
  });
  assert.equal(runState.status, 'completed');
  assert.deepEqual(postRunPersistenceErrors, [
    'recover assistant transcript: disk full',
    'persist assistant transcript: disk full',
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'thread_state_persist_failed', 'done'],
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['user'],
  );

  const artifacts = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.equal(artifacts.length, 0);
});

void test('executeForegroundRun persists provider-native checkpoint before the new assistant tail and rebuilds it after restart', async () => {
  const previousFlag = process.env[MID_RUN_STEER_ENABLED_ENV];
  process.env[MID_RUN_STEER_ENABLED_ENV] = '1';
  try {
    const threadId = testThreadId(35);
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-fg-native-compaction-'),
    );
    const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
    const runContext = makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    });
    const finalRound = providerFinalAnswerRound('assistant tail');
    const memoryPort = createAgentLoopMemoryPort({
      resolvePolicy: async () => ({
        providerId: 'openai_codex_direct',
        model: daemonContext.providerRequestOptions.model,
        contextWindow: 100,
        thresholdTokens: 90,
        supportsParallelToolCalls: true,
      }),
      compactHistory: async (input) => {
        assert.equal(input.history.at(-1)?.kind, 'user');
        return {
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
      ['user', 'compaction', 'assistant'],
    );
    const restartedHistory = await loadInitialHistory(
      workspaceRoot,
      threadId,
      'next prompt',
    );
    assert.equal(restartedHistory[0]?.kind, 'provider_native_compaction');
    assert.deepEqual(restartedHistory.slice(1), [
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: 'assistant tail',
      },
      { kind: 'user', text: 'next prompt' },
    ]);
  } finally {
    if (previousFlag === undefined) {
      delete process.env[MID_RUN_STEER_ENABLED_ENV];
    } else {
      process.env[MID_RUN_STEER_ENABLED_ENV] = previousFlag;
    }
  }
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
