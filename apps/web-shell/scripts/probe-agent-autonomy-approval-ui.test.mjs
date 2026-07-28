import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  attachRunChannelCdpObserver,
  createApprovalUiFrameObserver,
  createApprovalUiProbeArtifacts,
  runAgentAutonomyApprovalUiProbe,
} from './probe-agent-autonomy-approval-ui.mjs';
import { createAgentAutonomyWorkloadDeclaration } from '../../../scripts/evaluate-agent-autonomy.mjs';

const RUN_ID = 'run-approval-ui-r2';
const THREAD_ID = 'thread-approval-ui-r2';
const CALL_ID = 'call-write-marker';
const FILE_PATH = '/repo/.audit/probe/workspace/approval-marker.txt';
const FILE_CONTENT = 'marker\n';
const PROMPT = 'write exactly one marker';
const ANSWER = 'APPROVAL_UI_R2_COMPLETE';

class FakeCdpSession {
  #listeners = new Map();

  detached = false;
  sentMethods = [];

  on(event, listener) {
    this.#listeners.set(event, listener);
  }

  emit(event, payload) {
    this.#listeners.get(event)?.(payload);
  }

  async send(method) {
    this.sentMethods.push(method);
  }

  async detach() {
    this.detached = true;
  }
}

function runEvent(seq, type, payload, ts) {
  return JSON.stringify({
    type: 'run.event',
    event: {
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq,
      type,
      ts,
      payload,
    },
  });
}

function observePendingApproval() {
  const observer = createApprovalUiFrameObserver({
    expectedAnswer: ANSWER,
    expectedFileContent: FILE_CONTENT,
    expectedFilePath: FILE_PATH,
    expectedModelId: 'gpt-5.6-sol',
    expectedPrompt: PROMPT,
    expectedReasoningEffort: 'medium',
    expectedServiceTier: 'standard',
  });
  observer.arm();
  observer.observeSent(
    JSON.stringify({
      type: 'run.start',
      requestId: 'request-start',
      request: {
        prompt: PROMPT,
        modelId: 'gpt-5.6-sol',
        permissionMode: 'basic',
        reasoningEffort: 'medium',
        serviceTier: 'standard',
      },
    }),
    '2026-07-29T00:00:00.000Z',
  );
  observer.observeReceived(
    runEvent(
      0,
      'run_ack',
      { runId: RUN_ID, threadId: THREAD_ID },
      '2026-07-29T00:00:01.000Z',
    ),
  );
  observer.observeReceived(
    runEvent(
      1,
      'tool_call',
      {
        callId: CALL_ID,
        step: 1,
        tool: 'write_file',
        args: { path: FILE_PATH, content: FILE_CONTENT },
      },
      '2026-07-29T00:00:02.000Z',
    ),
  );
  observer.observeReceived(
    runEvent(
      2,
      'approval_required',
      {
        callId: CALL_ID,
        runId: RUN_ID,
        threadId: THREAD_ID,
        toolName: 'write_file',
        approvalClass: 'write_file',
        permissionMode: 'basic',
        argumentsPreview: { path: FILE_PATH },
        sideEffectLevel: 'write',
      },
      '2026-07-29T00:00:03.000Z',
    ),
  );
  return observer;
}

function observeManualApproval({ grantScope = 'once' } = {}) {
  const observer = observePendingApproval();
  observer.observeSent(
    JSON.stringify({
      type: 'run.approve',
      requestId: 'request-approve',
      request: {
        callId: CALL_ID,
        runId: RUN_ID,
        threadId: THREAD_ID,
        approved: true,
        grantScope,
      },
    }),
    '2026-07-29T00:00:05.000Z',
  );
  observer.observeReceived(
    runEvent(
      3,
      'tool_result',
      {
        callId: CALL_ID,
        step: 1,
        tool: 'write_file',
        ok: true,
        computerFilesMayHaveChanged: true,
        displayText: 'written',
        raw: { path: FILE_PATH },
      },
      '2026-07-29T00:00:06.000Z',
    ),
  );
  observer.observeReceived(
    runEvent(
      4,
      'usage_updated',
      { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
      '2026-07-29T00:00:07.000Z',
    ),
  );
  observer.observeReceived(
    runEvent(
      5,
      'done',
      { answer: ANSWER, ok: true },
      '2026-07-29T00:00:08.000Z',
    ),
  );
  return observer;
}

function declarationForAttempt(attemptReference) {
  return createAgentAutonomyWorkloadDeclaration({
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt: '2026-07-29T00:00:00.000Z',
    tasks: [
      {
        taskReferenceId: `sha256:${'1'.repeat(64)}`,
        eligibility: 'eligible',
        eligibilityReason: 'manual_write_approval_ui_vertical',
        attemptReferences: [attemptReference],
        interventionRules: [
          { reason: 'approval_or_authority', necessity: 'justified' },
        ],
      },
    ],
  });
}

void test('manual visible approval becomes one justified intervention without persisting content', () => {
  const run = observeManualApproval().snapshot();
  const attemptReference = `sha256:${'2'.repeat(64)}`;
  const declaration = declarationForAttempt(attemptReference);
  const artifacts = createApprovalUiProbeArtifacts({
    attemptReference,
    declaration,
    expectedFileContentReferenceId: `sha256:${'3'.repeat(64)}`,
    expectedFilePathReferenceId: `sha256:${'4'.repeat(64)}`,
    fileMatched: true,
    observedFileContentReferenceId: `sha256:${'3'.repeat(64)}`,
    providerId: 'openai',
    run,
    verifiedAt: '2026-07-29T00:00:09.000Z',
  });

  assert.equal(artifacts.verified, true);
  assert.equal(artifacts.report.primary.passedTaskCount, 1);
  const approvalIntervention =
    artifacts.report.supporting.interventions.byReason.find(
      (entry) => entry.reason === 'approval_or_authority',
    );
  assert.ok(approvalIntervention);
  assert.equal(approvalIntervention.justified, 1);
  assert.equal(approvalIntervention.observedLatencyMs, 2_000);
  assert.equal(artifacts.report.supporting.sideEffects.duplicateCount, 0);
  const persisted = JSON.stringify(artifacts);
  assert.equal(persisted.includes(FILE_PATH), false);
  assert.equal(persisted.includes(FILE_CONTENT), false);
  assert.equal(persisted.includes(PROMPT), false);
});

void test('a decision other than visible once-allow cannot satisfy the R2 oracle', () => {
  const run = observeManualApproval({ grantScope: 'session' }).snapshot();
  assert.deepEqual(run.violations, [
    'approval_decision_not_once_allow',
    'manual_approval_incomplete',
  ]);
});

void test('a started attempt preserves unresolved approval and failed oracle on timeout', () => {
  const run = observePendingApproval().fail(
    '2026-07-29T00:00:10.000Z',
    'probe_timeout',
  );
  assert.ok(run);
  const attemptReference = `sha256:${'5'.repeat(64)}`;
  const artifacts = createApprovalUiProbeArtifacts({
    attemptReference,
    declaration: declarationForAttempt(attemptReference),
    expectedFileContentReferenceId: `sha256:${'6'.repeat(64)}`,
    expectedFilePathReferenceId: `sha256:${'7'.repeat(64)}`,
    fileMatched: false,
    observedFileContentReferenceId: `sha256:${'8'.repeat(64)}`,
    providerId: 'openai_codex_direct',
    run,
    verifiedAt: '2026-07-29T00:00:10.000Z',
  });

  assert.equal(artifacts.verified, false);
  assert.equal(artifacts.report.primary.passedTaskCount, 0);
  assert.equal(artifacts.report.supporting.interventions.totalCount, 1);
  assert.equal(artifacts.report.supporting.interventions.justifiedCount, 1);
  assert.equal(
    artifacts.report.supporting.interventions.unresolvedLatencyCount,
    1,
  );
  assert.equal(artifacts.report.attempts[0].timelineComplete, false);
  assert.equal(artifacts.report.supporting.sideEffects.committedCount, 0);
  assert.deepEqual(run.violations, [
    'probe_timeout',
    'tool_result_count_mismatch',
    'manual_approval_incomplete',
  ]);
});

void test('the CDP observer routes only run-channel frames and detaches', async () => {
  const session = new FakeCdpSession();
  const sent = [];
  const received = [];
  const observation = await attachRunChannelCdpObserver({
    context: {
      async newCDPSession() {
        return session;
      },
    },
    now: () => new Date('2026-07-29T00:00:00.000Z'),
    observer: {
      observeSent(payload, at) {
        sent.push({ payload, at });
      },
      observeReceived(payload, at) {
        received.push({ payload, at });
      },
    },
    page: {},
  });

  session.emit('Network.webSocketCreated', {
    requestId: 'other',
    url: 'ws://127.0.0.1:3456/other',
  });
  session.emit('Network.webSocketCreated', {
    requestId: 'run-channel',
    url: 'ws://127.0.0.1:3456/api/ws',
  });
  session.emit('Network.webSocketFrameSent', {
    requestId: 'other',
    response: { payloadData: 'ignored' },
  });
  session.emit('Network.webSocketFrameSent', {
    requestId: 'run-channel',
    response: { payloadData: 'sent-frame' },
  });
  session.emit('Network.webSocketFrameReceived', {
    requestId: 'run-channel',
    response: { payloadData: 'received-frame' },
  });

  assert.deepEqual(session.sentMethods, ['Network.enable']);
  assert.equal(observation.observedSocketCount(), 1);
  assert.deepEqual(sent, [
    {
      payload: 'sent-frame',
      at: '2026-07-29T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(received, [
    {
      payload: 'received-frame',
      at: '2026-07-29T00:00:00.000Z',
    },
  ]);
  await observation.close();
  assert.equal(session.detached, true);
});

void test('the live probe disconnects its CDP browser when setup fails', async (t) => {
  const output = `.audit/approval-ui-probe-browser-close-${randomUUID()}`;
  t.after(async () => rm(resolve(output), { recursive: true, force: true }));
  let browserCloseCount = 0;

  await assert.rejects(
    runAgentAutonomyApprovalUiProbe({
      argv: [
        '--base-url',
        'http://127.0.0.1:3456/',
        '--cdp-url',
        'http://127.0.0.1:9225/',
        '--model-id',
        'gpt-5.6-sol',
        '--model-label',
        'GPT-5.6 Sol',
        '--output',
        output,
        '--provider-id',
        'openai_codex_direct',
        '--reasoning-effort',
        'medium',
        '--service-tier',
        'standard',
        '--timeout-ms',
        '1',
        '--working-directory',
        process.cwd(),
      ],
      env: {
        GEULBAT_AGENT_AUTONOMY_APPROVAL_UI_LIVE: '1',
      },
      async connectOverCDP() {
        return {
          contexts() {
            return [];
          },
          async close() {
            browserCloseCount += 1;
          },
        };
      },
      log() {},
    }),
    /CDP browser did not expose a browser context/u,
  );

  assert.equal(browserCloseCount, 1);
});
