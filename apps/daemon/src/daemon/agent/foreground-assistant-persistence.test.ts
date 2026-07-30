import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRunId } from '@geulbat/protocol/ids';

import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { persistForegroundAssistantAnswer } from './foreground-assistant-persistence.js';
import type { AgentInput } from './loop-types.js';
import {
  commitThreadArtifactUpdateVersion,
  commitThreadArtifactVersion,
  deleteThreadArtifact,
  deleteThreadArtifactUpdateVersion,
  loadAllThreadArtifactVersions,
} from '../sessions/artifact-store.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import { createRunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import {
  loadThreadIndex,
  upsertThreadSummary,
} from '../sessions/threads-index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';

function makeDeps(
  overrides: Partial<ResolvedExecuteForegroundRunDeps> = {},
): ResolvedExecuteForegroundRunDeps {
  return {
    appendTranscriptEntry,
    commitThreadArtifactVersion,
    commitThreadArtifactUpdateVersion,
    deleteThreadArtifact,
    deleteThreadArtifactUpdateVersion,
    readTranscriptEntries,
    replaceTranscriptEntries,
    loadThreadIndex,
    upsertThreadSummary,
    now: () => FIXED_NOW,
    onPostRunPersistenceError: () => {},
    ...overrides,
  };
}

function makeAgentInput(args: {
  workspaceRoot: string;
  threadId: ReturnType<typeof testThreadId>;
  events: AgentEvent[];
}): AgentInput {
  const runContext = makeRunContext({
    stateRoot: args.workspaceRoot,
    threadId: args.threadId,
  });
  return {
    runId: 'run-foreground-assistant',
    runContext,
    prompt: 'prompt',
    currentFile: 'episodes/ch01.md',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext(),
    onEvent: (event) => {
      args.events.push(event);
    },
  };
}

void test('persistForegroundAssistantAnswer rolls back a just-committed artifact when transcript persistence cannot recover', async () => {
  const threadId = testThreadId(1201);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const diagnostics: string[] = [];

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '\n# Title\n',
        digest: 'sha256:artifact',
      },
    },
    deps: makeDeps({
      appendTranscriptEntry: async () => {
        throw new Error('append failed');
      },
      readTranscriptEntries: async () => {
        throw new Error('recovery read failed');
      },
      onPostRunPersistenceError: (phase) => {
        diagnostics.push(phase);
      },
    }),
  });

  assert.equal(persisted, false);
  assert.deepEqual(events, []);
  assert.deepEqual(diagnostics, [
    'recover assistant transcript',
    'persist assistant transcript',
  ]);
  assert.deepEqual(
    await loadAllThreadArtifactVersions(workspaceRoot, threadId),
    [],
  );
});

void test('persistForegroundAssistantAnswer commits an update-target envelope as the next version of the same artifact', async () => {
  const threadId = testThreadId(1203);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const seeded = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-seed',
    renderer: 'markdown',
    payload: '# v1',
    digest: null,
    sourceRef: null,
    timestamp: '2026-04-01T00:00:00.000Z',
  });

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '다시 만들었어요.',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '\n# v2 (재작성)\n',
        digest: null,
        updateTarget: {
          artifactId: seeded.artifact.artifactId,
          baseVersion: 1,
        },
      },
    },
    deps: makeDeps(),
  });

  assert.equal(persisted, true);
  const versions = await loadAllThreadArtifactVersions(workspaceRoot, threadId);
  // 새 artifactId가 생기지 않고 같은 아티팩트에 v2가 쌓인다
  assert.deepEqual(
    versions.map((artifact) => [artifact.artifactId, artifact.version]),
    [
      [seeded.artifact.artifactId, 1],
      [seeded.artifact.artifactId, 2],
    ],
  );
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const assistant = transcript.at(-1);
  assert.equal(assistant?.role, 'assistant');
  assert.deepEqual(assistant?.metadata?.activeArtifactRef, {
    artifactId: seeded.artifact.artifactId,
    version: 2,
  });
  // artifact_committed 이벤트도 새 버전을 실어 UI가 표면을 갱신한다
  const committedEvent = events.find(
    (event) => event.type === 'artifact_committed',
  );
  assert.ok(committedEvent);
  assert.equal((committedEvent.payload as { version: number }).version, 2);
});

void test('persistForegroundAssistantAnswer falls back to a fresh artifact when the update target is invalid', async () => {
  const threadId = testThreadId(1204);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const seeded = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-seed',
    renderer: 'markdown',
    payload: '# v1',
    digest: null,
    sourceRef: null,
    timestamp: '2026-04-01T00:00:00.000Z',
  });

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '다시 만들었어요.',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '\n# 스테일 재작성\n',
        digest: null,
        // 스테일 baseVersion — 콘텐츠를 잃지 않도록 새 아티팩트로 폴백
        updateTarget: {
          artifactId: seeded.artifact.artifactId,
          baseVersion: 7,
        },
      },
    },
    deps: makeDeps(),
  });

  assert.equal(persisted, true);
  const versions = await loadAllThreadArtifactVersions(workspaceRoot, threadId);
  assert.equal(versions.length, 2);
  const fallback = versions.find(
    (artifact) => artifact.artifactId !== seeded.artifact.artifactId,
  );
  assert.ok(fallback);
  assert.equal(fallback.version, 1);
  assert.equal(fallback.payload, '\n# 스테일 재작성\n');
  // 원본 아티팩트는 v1 그대로 — update가 오염되지 않는다
  assert.equal(
    versions.filter(
      (artifact) => artifact.artifactId === seeded.artifact.artifactId,
    ).length,
    1,
  );
});

void test('persistForegroundAssistantAnswer binds tool-committed artifact refs into assistant metadata', async () => {
  const threadId = testThreadId(1202);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '이미지를 생성했어요.',
    },
    toolCommittedArtifactRefs: [{ artifactId: 'art_img', version: 1 }],
    deps: makeDeps(),
  });

  assert.equal(persisted, true);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const assistant = transcript.at(-1);
  assert.ok(assistant);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.metadata?.artifactRefs, [
    { artifactId: 'art_img', version: 1 },
  ]);
  assert.deepEqual(assistant.metadata?.activeArtifactRef, {
    artifactId: 'art_img',
    version: 1,
  });
});

void test('assistant envelope artifact stays active over tool-committed refs', async () => {
  const threadId = testThreadId(1203);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];

  const persisted = await persistForegroundAssistantAnswer({
    agentInput: makeAgentInput({ workspaceRoot, threadId, events }),
    result: {
      ok: true,
      finalProse: '',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '# Title',
        digest: 'sha256:artifact',
      },
    },
    toolCommittedArtifactRefs: [{ artifactId: 'art_img', version: 1 }],
    deps: makeDeps(),
  });

  assert.equal(persisted, true);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const assistant = transcript.at(-1);
  assert.ok(assistant);
  const refs = assistant.metadata?.artifactRefs ?? [];
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { artifactId: 'art_img', version: 1 });
  // 어시스턴트 본문 아티팩트가 active로 우선한다.
  const active = assistant.metadata?.activeArtifactRef;
  assert.ok(active);
  assert.notEqual(active.artifactId, 'art_img');
});

void test('planning output persists the latest daemon-issued stamp on the final answer and artifact version', async () => {
  const threadId = testThreadId(1205);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const runtimeServices = createDaemonContext({ homeStateRoot: workspaceRoot });
  const collecting = await runtimeServices.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.equal(collecting?.state, 'collecting');
  if (collecting === null) {
    throw new Error('expected collecting workflow');
  }
  const proposed = await runtimeServices.planningWorkflows.propose({
    threadId,
    proposalRunId: assertRunId('run-foreground-assistant'),
    draft: {
      schemaVersion: 'plan_draft_v1',
      outcome: 'Ship stamped plan renderings',
      steps: [
        {
          id: 'stamp',
          text: 'Persist the plan rendering stamp',
          acceptanceCriteria: ['Artifact and final answer carry one exact ref'],
        },
      ],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
  });
  const agentInput = makeAgentInput({ workspaceRoot, threadId, events });
  agentInput.runtimeServices = runtimeServices;
  agentInput.planningWorkflow = {
    workflowId: collecting.workflowId,
    intensity: collecting.intensity,
    depth: collecting.depth,
  };

  const persisted = await persistForegroundAssistantAnswer({
    agentInput,
    result: {
      ok: true,
      finalProse: '이 명세는 현재 계획에서 만들었습니다.',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '# 계획 명세',
        digest: null,
      },
    },
    deps: makeDeps(),
  });

  assert.equal(persisted, true);
  const expectedStamp = {
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  };
  const artifact = (
    await loadAllThreadArtifactVersions(workspaceRoot, threadId)
  ).at(-1);
  assert.deepEqual(artifact?.planStamp, expectedStamp);
  const assistant = (await readTranscriptEntries(workspaceRoot, threadId)).at(
    -1,
  );
  assert.deepEqual(assistant?.metadata?.planStamp, expectedStamp);
});

void test('a settled assistant artifact and transcript re-enter exactly once after restart', async () => {
  const threadId = testThreadId(1206);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-assistant-'));
  const events: AgentEvent[] = [];
  const runId = assertRunId('run-foreground-assistant');
  const identity = `sha256:${'6'.repeat(64)}` as const;
  const providerRequestIdentity = 'b'.repeat(64);
  const candidateDigest = `sha256:${'7'.repeat(64)}` as const;
  const runCheckpoints = createRunCheckpointStore({
    stateRoot: workspaceRoot,
    now: () => FIXED_NOW,
  });
  await runCheckpoints.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  assert.equal(
    (
      await runCheckpoints.recordModelRoundPrepared?.({
        threadId,
        runId,
        active: {
          round: 0,
          claimId: 'settled-assistant-claim',
          modelRoundAttempt: 0,
          providerRequestAttempt: 0,
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-sol',
          transportKind: 'websocket',
          providerRequestIdentity,
          contextDigest: `sha256:${'8'.repeat(64)}`,
          toolLibraryProjectionIdentity: {
            sdkVersion: 'sdk-settled-assistant-v1',
            sdkProjectionHash: `sha256:${'9'.repeat(64)}`,
            policyId: 'sha256:settled-assistant-policy',
          },
          responseFormat: null,
          providerReplayScopeId: null,
          logicalRequestIdentity: identity,
        },
      })
    )?.ok,
    true,
  );
  assert.equal(
    (
      await runCheckpoints.markModelRoundPhase?.({
        threadId,
        runId,
        claimId: 'settled-assistant-claim',
        providerRequestIdentity,
        phase: 'terminal_observed',
      })
    )?.ok,
    true,
  );
  assert.equal(
    (
      await runCheckpoints.recordModelRoundSettlementCandidate?.({
        threadId,
        runId,
        claimId: 'settled-assistant-claim',
        logicalRequestIdentity: identity,
        providerRequestIdentity,
        candidateDigest,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cachedInputTokens: 1,
        },
      })
    )?.ok,
    true,
  );
  const result = {
    ok: true,
    finalProse: '',
    artifactCandidate: {
      renderer: 'markdown' as const,
      payload: '# settled artifact',
      digest: 'sha256:settled-artifact',
    },
    modelSettlementIdentity: identity,
  };
  assert.equal(
    (
      await runCheckpoints.commitModelRoundSettlement?.({
        threadId,
        runId,
        claimId: 'settled-assistant-claim',
        logicalRequestIdentity: identity,
        candidateDigest,
        resultDigest: `sha256:${'a'.repeat(64)}`,
        result,
        disposition: 'terminal',
        source: 'natural',
        continuationHistoryText: null,
      })
    )?.ok,
    true,
  );

  const artifactId = `art_model_${identity.slice('sha256:'.length)}`;
  await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId,
    artifactId,
    renderer: result.artifactCandidate.renderer,
    payload: result.artifactCandidate.payload,
    digest: result.artifactCandidate.digest,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: '',
      threadId,
      runId,
      filePath: 'episodes/ch01.md',
      messageTimestamp: FIXED_NOW,
    },
    timestamp: FIXED_NOW,
  });

  const agentInput = makeAgentInput({ workspaceRoot, threadId, events });
  agentInput.runtimeServices = {
    ...createDaemonContext(),
    runCheckpoints,
  };
  assert.equal(
    await persistForegroundAssistantAnswer({
      agentInput,
      result,
      deps: makeDeps(),
    }),
    true,
  );
  assert.equal(
    await persistForegroundAssistantAnswer({
      agentInput,
      result,
      deps: makeDeps(),
    }),
    true,
  );
  const diagnostics: string[] = [];
  assert.equal(
    await persistForegroundAssistantAnswer({
      agentInput,
      result: {
        ...result,
        finalProse: 'conflicting replay',
      },
      deps: makeDeps({
        onPostRunPersistenceError: (phase) => diagnostics.push(phase),
      }),
    }),
    false,
  );
  assert.equal(
    await persistForegroundAssistantAnswer({
      agentInput,
      result: {
        ...result,
        artifactCandidate: {
          ...result.artifactCandidate,
          payload: '# conflicting settled artifact',
        },
      },
      deps: makeDeps({
        onPostRunPersistenceError: (phase) => diagnostics.push(phase),
      }),
    }),
    false,
  );
  assert.deepEqual(diagnostics, [
    'persist assistant transcript',
    'persist assistant transcript',
  ]);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript.length, 1);
  assert.equal(
    transcript[0]?.entryId,
    `model_settlement_${identity.slice('sha256:'.length)}`,
  );
  assert.equal(transcript[0]?.metadata?.modelSettlementIdentity, identity);
  const versions = await loadAllThreadArtifactVersions(workspaceRoot, threadId);
  assert.deepEqual(
    versions.map((version) => [
      version.artifactId,
      version.version,
      version.payload,
    ]),
    [[artifactId, 1, '# settled artifact']],
  );
  assert.equal(
    events.filter((event) => event.type === 'artifact_committed').length,
    1,
  );
});
