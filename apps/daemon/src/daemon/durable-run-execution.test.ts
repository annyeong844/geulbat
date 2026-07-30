import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId } from '@geulbat/protocol/ids';
import { VIDEO_GENERATION_MODEL_CATALOG } from '@geulbat/protocol/run-contract';

import { testThreadId } from '../test-support/thread-id.js';
import { createDaemonContext } from './context.js';
import {
  buildRunScopedRuntimeServices,
  publishLiveAgentEvent,
  reconcilePersistedTerminalCheckpoint,
  recoverDurableRunsAtDaemonStartup,
  startDurableRunRecovery,
} from './durable-run-execution.js';
import type {
  ImageGenerationRequestDefaults,
  ImageGenerationRuntime,
  VideoGenerationRequestDefaults,
  VideoGenerationRuntime,
} from './media/contract.js';
import {
  createLiveRunEventStore,
  type LiveRunEventSink,
} from './sessions/live-run-events.js';
import { appendTranscriptEntry } from './sessions/transcript-log.js';

void test('publishLiveAgentEvent keeps transient tool output out of durable history', async () => {
  const liveRunEvents = createLiveRunEventStore();
  const runId = assertRunId('run-durable-publish-routing');
  const threadId = testThreadId(1801);
  const delivered: string[] = [];
  const persisted: string[] = [];
  const sink: LiveRunEventSink = (envelope) => {
    delivered.push(envelope.event.type);
    return true;
  };
  sink.transient = (envelope) => {
    delivered.push(envelope.event.type);
    return true;
  };

  liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: 'durable-publish-routing-test',
    sink,
    async persistRunEvents(events) {
      persisted.push(...events.map(({ event }) => event.type));
    },
  });

  publishLiveAgentEvent(liveRunEvents, runId, {
    type: 'commentary_delta',
    payload: { text: 'durable progress' },
  });
  publishLiveAgentEvent(liveRunEvents, runId, {
    type: 'tool_output_delta',
    payload: {
      callId: 'call-durable-publish-routing',
      tool: 'exec_command',
      stream: 'stderr',
      text: 'transient diagnostics',
    },
  });
  await liveRunEvents.flushRunEventHistory(runId);

  assert.deepEqual(delivered, ['commentary_delta', 'tool_output_delta']);
  assert.deepEqual(persisted, ['commentary_delta']);
});

void test('persisted final answers settle only quiescent matching checkpoints', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-durable-settle-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });

  const pendingThreadId = testThreadId(1802);
  const pendingRunId = assertRunId('run-durable-pending-interject');
  const pendingStarted = await daemonContext.runCheckpoints.startRun({
    runId: pendingRunId,
    threadId: pendingThreadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(pendingStarted.ok, true);
  await daemonContext.runCheckpoints.enqueueInterject({
    threadId: pendingThreadId,
    runId: pendingRunId,
    interject: { receivedSeq: 1, text: 'apply this before settling' },
  });
  const pendingCheckpoint =
    await daemonContext.runCheckpoints.readThread(pendingThreadId);
  assert.ok(pendingCheckpoint);
  assert.equal(
    await reconcilePersistedTerminalCheckpoint(
      daemonContext,
      pendingCheckpoint,
    ),
    null,
  );

  const settledThreadId = testThreadId(1803);
  const settledRunId = assertRunId('run-durable-persisted-final');
  const modelSettlementIdentity = `sha256:${'e'.repeat(64)}` as const;
  const settledStarted = await daemonContext.runCheckpoints.startRun({
    runId: settledRunId,
    threadId: settledThreadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(settledStarted.ok, true);
  await daemonContext.runCheckpoints.appendRunEvents({
    threadId: settledThreadId,
    runId: settledRunId,
    events: [
      {
        seq: 0,
        event: {
          type: 'commentary_delta',
          payload: { text: 'persisted progress' },
        },
      },
    ],
  });
  await appendTranscriptEntry(stateRoot, settledThreadId, {
    role: 'assistant',
    content: 'another run answer',
    timestamp: '2026-07-28T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      sourceRunId: assertRunId('run-durable-other-final'),
    },
  });
  const beforeMatchingAnswer =
    await daemonContext.runCheckpoints.readThread(settledThreadId);
  assert.ok(beforeMatchingAnswer);
  assert.equal(
    await reconcilePersistedTerminalCheckpoint(
      daemonContext,
      beforeMatchingAnswer,
    ),
    null,
  );
  await appendTranscriptEntry(stateRoot, settledThreadId, {
    role: 'assistant',
    content: 'the durable answer',
    timestamp: '2026-07-28T00:00:01.000Z',
    metadata: {
      phase: 'final_answer',
      sourceRunId: settledRunId,
      modelSettlementIdentity,
    },
  });
  const readyCheckpoint =
    await daemonContext.runCheckpoints.readThread(settledThreadId);
  assert.ok(readyCheckpoint);

  const reconciled = await reconcilePersistedTerminalCheckpoint(
    daemonContext,
    readyCheckpoint,
  );

  assert.equal(reconciled?.status, 'terminal');
  assert.deepEqual(reconciled?.terminal, {
    eventCursor: 2,
    event: {
      type: 'done',
      payload: { answer: 'the durable answer', ok: true },
    },
    acknowledged: false,
    modelSettlementIdentity,
  });
});

void test('persisted thread deltas already own the recovery snapshot cursor', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-durable-delta-settle-'),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = testThreadId(1804);
  const runId = assertRunId('run-durable-persisted-delta');
  const started = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(started.ok, true);
  await daemonContext.runCheckpoints.appendRunEvents({
    threadId,
    runId,
    events: [
      {
        seq: 0,
        event: {
          type: 'thread_state_delta_persisted',
          payload: {
            threadId,
            snapshotVersion: '2026-07-28T00:00:01.000Z',
            baseEntryId: null,
            messages: [],
            artifacts: [],
          },
        },
      },
    ],
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: 'the durable delta answer',
    timestamp: '2026-07-28T00:00:01.000Z',
    metadata: { phase: 'final_answer', sourceRunId: runId },
  });
  const checkpoint = await daemonContext.runCheckpoints.readThread(threadId);
  assert.ok(checkpoint);

  const reconciled = await reconcilePersistedTerminalCheckpoint(
    daemonContext,
    checkpoint,
  );

  assert.equal(reconciled?.status, 'terminal');
  assert.equal(reconciled?.terminal?.eventCursor, 1);
});

void test('startup recovery durably reports a missing semantic model boundary', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-durable-model-round-missing-'),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = testThreadId(1805);
  const runId = assertRunId('run-durable-model-round-missing');
  const started = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const deliveredCodes: string[] = [];

  const recovery = await startDurableRunRecovery(
    daemonContext,
    { ...started.checkpoint, modelRoundState: null },
    {
      ownerId: 'replacement-daemon',
      sink(envelope) {
        if (envelope.event.type === 'error') {
          deliveredCodes.push(envelope.event.payload.code);
        }
        return true;
      },
    },
  );

  assert.equal(recovery, null);
  assert.deepEqual(deliveredCodes, ['llm_provider_request_outcome_unknown']);
  const settled = await daemonContext.runCheckpoints.readThread(threadId);
  assert.equal(settled?.status, 'terminal');
  assert.equal(
    settled?.terminal?.event.type === 'error'
      ? settled.terminal.event.payload.code
      : undefined,
    'llm_provider_request_outcome_unknown',
  );
});

void test('startup recovery isolates an unresolved root checkpoint without blocking daemon boot', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-durable-root-recovery-isolation-'),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = testThreadId(1806);
  const runId = assertRunId('run-durable-root-recovery-isolation');
  const started = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(started.ok, true);
  const invocation = await daemonContext.runCheckpoints.recordToolInvocation({
    threadId,
    runId,
    invocation: {
      callId: 'call-root-recovery-isolation',
      toolName: 'agent_send_input',
      recoveryStrategy: 'reconcile_then_replay',
      recoveryState: { childRunId: 'run-child-recovery-isolation' },
    },
  });
  assert.equal(invocation.ok, true);
  const reconciled =
    await daemonContext.runCheckpoints.recordToolInvocationResult({
      threadId,
      runId,
      callId: 'call-root-recovery-isolation',
      toolName: 'agent_send_input',
      result: { ok: true, output: 'continued' },
    });
  assert.equal(reconciled.ok, true);
  const persisted = await daemonContext.runCheckpoints.readThread(threadId);
  assert.ok(persisted);
  const recoveryContext = {
    ...daemonContext,
    runCheckpoints: {
      ...daemonContext.runCheckpoints,
      async listRecoveryCandidates() {
        return {
          running: [{ ...persisted, modelRoundState: null }],
          unacknowledgedTerminal: [],
        };
      },
    },
  };

  assert.equal(await recoverDurableRunsAtDaemonStartup(recoveryContext), 0);
  assert.equal(
    (await daemonContext.runCheckpoints.readThread(threadId))?.status,
    'running',
  );
});

void test('startup recovery claims the persisted active model boundary before loop admission', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-durable-model-round-claim-'),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    agentLoopImplementationAdmission: {
      async admitRun() {
        return {
          ok: false,
          reason: 'implementation_unavailable',
          implementationId: 'test.unavailable',
          supportedContractVersion: '1',
          message: 'expected admission stop after the recovery claim',
        };
      },
    },
  });
  const threadId = testThreadId(1806);
  const runId = assertRunId('run-durable-model-round-claim');
  const originalClaimId = 'claim-before-daemon-replacement';
  const providerRequestIdentity = 'a'.repeat(64);
  const started = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: stateRoot, permissionMode: 'basic' },
  });
  assert.equal(started.ok, true);
  const prepared =
    await daemonContext.runCheckpoints.recordModelRoundPrepared?.({
      threadId,
      runId,
      active: {
        round: 0,
        claimId: originalClaimId,
        modelRoundAttempt: 0,
        providerRequestAttempt: 0,
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-sol',
        transportKind: 'websocket',
        providerRequestIdentity,
        contextDigest: `sha256:${'b'.repeat(64)}`,
        toolLibraryProjectionIdentity: {
          sdkVersion: 'sdk-model-round-v1',
          sdkProjectionHash: `sha256:${'c'.repeat(64)}`,
          policyId: 'sha256:model-round-policy',
        },
        responseFormat: null,
        providerReplayScopeId: null,
        logicalRequestIdentity: `sha256:${'d'.repeat(64)}`,
      },
    });
  assert.equal(prepared?.ok, true);
  const checkpoint = await daemonContext.runCheckpoints.readThread(threadId);
  assert.ok(checkpoint);

  const recovery = await startDurableRunRecovery(daemonContext, checkpoint, {
    ownerId: 'replacement-daemon',
    sink: () => true,
  });

  assert.equal(recovery, null);
  const claimed = await daemonContext.runCheckpoints.readThread(threadId);
  assert.equal(claimed?.modelRoundState?.active?.claimRevision, 2);
  assert.notEqual(claimed?.modelRoundState?.active?.claimId, originalClaimId);
  assert.equal(
    claimed?.modelRoundState?.active?.providerRequestIdentity,
    providerRequestIdentity,
  );
});

void test('run-scoped media defaults derive runtimes without mutating daemon singletons', () => {
  const daemonContext = createDaemonContext();
  const imageDefaults: ImageGenerationRequestDefaults[] = [];
  const videoDefaults: VideoGenerationRequestDefaults[] = [];

  const derivedImageGeneration: ImageGenerationRuntime = {
    async generateImageArtifact() {
      throw new Error('unused');
    },
    withRequestDefaults() {
      return derivedImageGeneration;
    },
  };
  const imageGeneration: ImageGenerationRuntime = {
    async generateImageArtifact() {
      throw new Error('unused');
    },
    withRequestDefaults(defaults) {
      imageDefaults.push(defaults);
      return derivedImageGeneration;
    },
  };
  const derivedVideoGeneration: VideoGenerationRuntime = {
    async generateVideoArtifact() {
      throw new Error('unused');
    },
    withRequestDefaults() {
      return derivedVideoGeneration;
    },
  };
  const videoGeneration: VideoGenerationRuntime = {
    async generateVideoArtifact() {
      throw new Error('unused');
    },
    withRequestDefaults(defaults) {
      videoDefaults.push(defaults);
      return derivedVideoGeneration;
    },
  };
  daemonContext.imageGeneration = imageGeneration;
  daemonContext.videoGeneration = videoGeneration;

  const unchanged = buildRunScopedRuntimeServices({}, daemonContext);
  assert.equal(unchanged.imageGeneration, imageGeneration);
  assert.equal(unchanged.videoGeneration, videoGeneration);

  const selected = buildRunScopedRuntimeServices(
    {
      imageGenerationModel: 'gpt-image-2',
      videoGenerationModel: 'grok-imagine-video-1.5',
      videoGenerationSettings: {
        durationSeconds: 8,
        aspectRatio: '16:9',
        resolution: '720p',
      },
    },
    daemonContext,
  );
  assert.equal(selected.imageGeneration, derivedImageGeneration);
  assert.equal(selected.videoGeneration, derivedVideoGeneration);
  assert.deepEqual(imageDefaults, [
    { providerId: 'openai_codex_direct', model: 'gpt-image-2' },
  ]);
  assert.deepEqual(videoDefaults, [
    {
      model: 'grok-imagine-video-1.5',
      durationSeconds: 8,
      aspectRatio: '16:9',
      resolution: '720p',
    },
  ]);

  buildRunScopedRuntimeServices(
    { videoGenerationSettings: { aspectRatio: '9:16' } },
    daemonContext,
  );
  assert.deepEqual(videoDefaults.at(-1), {
    model: VIDEO_GENERATION_MODEL_CATALOG[0].id,
    aspectRatio: '9:16',
  });
});
