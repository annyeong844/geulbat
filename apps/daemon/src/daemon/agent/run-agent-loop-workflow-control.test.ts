import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import { runAgentLoop } from './run-agent-loop.js';
import type { AgentEvent } from './events.js';
import { createRunState } from './runtime/run-state.js';
import { createDaemonContext } from '../context.js';
import {
  isInterjectFlushRequested,
  pushPendingInterject,
  requestInterjectFlush,
  restorePendingInterjectFront,
} from '../sessions/active-run-interject-buffer.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { persistSingleInterjectToTranscript } from './loop-history.js';
import { updatePlanTool } from '../tools/builtin/update-plan.js';
import { ProviderReplayScopeMismatchError } from '../llm/provider/provider-replay-scope.js';
import type { HistoryItem } from '../llm/index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { withoutProviderStatus } from '../../test-support/agent-events.js';
import {
  registerOnce,
  startApprovalCheckpoint,
} from '../../test-support/loop-tool-execution-test-support.js';
import {
  createTestContextBudgetRound,
  makePathArgumentTestTool,
} from '../../test-support/run-agent-loop.js';

void test('runAgentLoop refuses to leave a collecting workflow on final prose alone', async () => {
  const threadId = testThreadId(1213);
  const daemonContext = createDaemonContext();
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-planning-terminal-gate-'),
  );
  let modelRound = 0;
  const planningWorkflows = {
    ...daemonContext.planningWorkflows,
    async readThread() {
      return {
        state: 'collecting' as const,
        workflowId: 'workflow-terminal-gate',
        threadId,
        intensity: 'quiet' as const,
        depth: 'deep' as const,
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-planning-terminal-gate',
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'plan this carefully',
    planningWorkflow: {
      workflowId: 'workflow-terminal-gate',
      intensity: 'quiet',
      depth: 'deep',
    },
    runtimeServices: { ...daemonContext, planningWorkflows },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-planning-terminal-gate',
    }),
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '설명은 여기까지입니다.',
              terminalResult: {
                ok: true,
                finalProse: '설명은 여기까지입니다.',
              },
              functionCalls: [],
            },
          };
        }
        assert.equal(modelRound, 2);
        return {
          ok: true,
          value: {
            assistantText: '',
            terminalResult: {
              ok: true,
              finalProse: '사용자 결정을 기다립니다.',
            },
            functionCalls: [
              {
                id: 'fc-planning-ask-user',
                callId: 'call-planning-ask-user',
                name: 'ask_user',
                arguments: '{}',
              },
            ],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        args.observeToolResult?.({
          schemaVersion: 1,
          runId: args.runId,
          threadId,
          callId: 'call-planning-ask-user',
          toolName: 'ask_user',
          outcome: 'success',
          elapsedMs: null,
          fullOutputBytes: 0,
          modelVisibleBytes: 0,
          parseQuality: 'structured_json',
          projection: 'inline',
          exactDurableRecovery: false,
        });
        return { ok: true, value: undefined };
      },
    },
    onEvent() {},
  });

  assert.equal(modelRound, 2);
  assert.deepEqual(result, {
    ok: true,
    finalProse: '사용자 결정을 기다립니다.',
  });
});

void test('runAgentLoop continues until the exact approved-plan execution is complete', async () => {
  const threadId = testThreadId(1212);
  const runId = testRunId(1212);
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-approved-plan-completion-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const draft: PlanDraftV1 = {
    schemaVersion: 'plan_draft_v1',
    outcome: 'Finish the approved implementation',
    steps: [
      {
        id: 'implementation',
        text: 'Implement the approved change',
        acceptanceCriteria: ['The implementation is complete'],
      },
      {
        id: 'verification',
        text: 'Run the approved verification',
        acceptanceCriteria: ['The verification passes'],
      },
    ],
    decisions: [],
    assumptions: [],
    openQuestions: [],
  };
  await daemonContext.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  const proposed = await daemonContext.planningWorkflows.propose({
    threadId,
    proposalRunId: testRunId(1211),
    draft,
  });
  if (proposed.state !== 'awaiting_approval') {
    throw new Error('expected proposed plan');
  }
  const approved = await daemonContext.planningWorkflows.applyCommand({
    kind: 'approve',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  if (approved.approvedPlanRef === undefined) {
    throw new Error('expected approved plan ref');
  }
  await daemonContext.planningWorkflows.claimExecution({
    ref: approved.approvedPlanRef,
    threadId,
    executionRunId: runId,
  });

  const history: HistoryItem[] = [{ kind: 'user', text: 'execute the plan' }];
  let modelRound = 0;
  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'execute the plan',
    approvedPlan: { ref: approved.approvedPlanRef, draft },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-approved-plan-completion',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: 'premature completion',
              terminalResult: {
                ok: true,
                finalProse: 'premature completion',
              },
              functionCalls: [],
            },
          };
        }
        assert.equal(modelRound, 2);
        assert.equal(
          history.some(
            (item) =>
              item.kind === 'assistant' &&
              item.text.includes('"verdict":"not_achieved"') &&
              item.text.includes('"id":"implementation"') &&
              item.text.includes('"id":"verification"'),
          ),
          true,
        );
        const progress = await updatePlanTool.execute(
          {
            plan: draft.steps.map((step) => ({
              id: step.id,
              step: step.text,
              status: 'completed' as const,
            })),
          },
          {
            callId: 'call-approved-plan-complete',
            stateRoot,
            threadId,
          },
        );
        assert.equal(progress.ok, true);
        return {
          ok: true,
          value: {
            assistantText: 'approved plan complete',
            terminalResult: {
              ok: true,
              finalProse: 'approved plan complete',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent() {},
  });

  assert.equal(modelRound, 2);
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'approved plan complete',
  });
});

void test('runAgentLoop exposes update_goal only in Goal mode and completes after host obligations pass', async () => {
  const threadId = testThreadId(1214);
  const runId = testRunId(1214);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-goal-'));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const snapshot = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Finish the Goal integration',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(snapshot);

  const history: HistoryItem[] = [
    { kind: 'user', text: 'Finish the Goal integration' },
  ];
  const events: AgentEvent[] = [];
  let modelRound = 0;
  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'Finish the Goal integration',
    goal: {
      goalId: snapshot.goalId,
      objective: snapshot.objective,
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-goal-completion',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        modelRound += 1;
        assert.equal(
          args.toolDefs.some((definition) => definition.name === 'update_goal'),
          true,
        );
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: {
                ok: true,
                finalProse: '',
              },
              functionCalls: [
                {
                  id: 'fc-goal-complete',
                  callId: 'call-goal-complete',
                  name: 'update_goal',
                  arguments: '{"status":"complete"}',
                },
              ],
            },
          };
        }
        assert.equal(
          history.some(
            (item) =>
              item.kind === 'assistant' &&
              item.text.includes('"kind":"goal_completion_admitted"'),
          ),
          true,
        );
        return {
          ok: true,
          value: {
            assistantText: 'Goal integration is complete.',
            terminalResult: {
              ok: true,
              finalProse: 'Goal integration is complete.',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(modelRound, 2);
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'Goal integration is complete.',
  });
  assert.equal(
    (await daemonContext.goals.readThread(threadId))?.state,
    'completed',
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'goal_updated')
      .map((event) => event.payload.state),
    ['verifying', 'completed'],
  );
});

void test('runAgentLoop does not expose Goal completion admission in ordinary chat', async () => {
  const threadId = testThreadId(1215);
  const runId = testRunId(1215);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-no-goal-'));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });

  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'Answer an ordinary question',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-no-goal',
    }),
    modelRoundPort: {
      async runModelRound(args) {
        assert.equal(
          args.toolDefs.some((definition) => definition.name === 'update_goal'),
          false,
        );
        assert.equal(
          args.toolDefs.some(
            (definition) => definition.name === 'submit_result_report',
          ),
          false,
        );
        return {
          ok: true,
          value: {
            assistantText: 'Ordinary answer.',
            terminalResult: {
              ok: true,
              finalProse: 'Ordinary answer.',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'Ordinary answer.',
  });
});

void test('runAgentLoop ignores stale thread plan state without an approved execution binding', async () => {
  const threadId = testThreadId(1213);
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-stale-plan-completion-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const stale = await updatePlanTool.execute(
    {
      plan: [{ step: 'old unfinished work', status: 'in_progress' }],
    },
    {
      callId: 'call-stale-plan',
      stateRoot,
      threadId,
    },
  );
  assert.equal(stale.ok, true);
  let modelRound = 0;

  const result = await runAgentLoop({
    runId: testRunId(1213),
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'answer a new ordinary question',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-stale-plan-completion',
    }),
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        return {
          ok: true,
          value: {
            assistantText: 'ordinary answer',
            terminalResult: {
              ok: true,
              finalProse: 'ordinary answer',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent() {},
  });

  assert.equal(modelRound, 1);
  assert.deepEqual(result, { ok: true, finalProse: 'ordinary answer' });
});

void test('runAgentLoop surfaces a persisted replay-scope mismatch as a terminal auth error', async () => {
  const events: AgentEvent[] = [];
  const daemonContext = createDaemonContext();

  const result = await runAgentLoop({
    runId: 'run-loop-replay-scope-mismatch',
    runContext: makeRunContext({ threadId: testThreadId(1210) }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext(),
    historyPort: {
      async loadInitialHistory() {
        throw new ProviderReplayScopeMismatchError();
      },
    },
    async *callModelImpl() {
      assert.fail('provider call must not start after replay-scope mismatch');
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(events.at(-1)?.type, 'error');
  const terminal = events.at(-1);
  if (terminal?.type === 'error') {
    assert.equal(terminal.payload.code, 'llm_auth_failed');
    assert.equal(terminal.payload.message, 'provider authentication failed');
  }
});

void test('runAgentLoop accumulates model-round and compaction usage in emission order', async (t) => {
  const threadId = testThreadId(77);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-usage-'));
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const runId = testRunId('loop-usage');
  const daemonContext = createDaemonContext({
    homeStateRoot: workspaceRoot,
  });
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  const events: AgentEvent[] = [];
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({ runId, runContext });

  const finalRound = providerFinalAnswerRound('usage done');
  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'report usage',
    runState,
    runtimeServices: daemonContext,
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async compactAfterModelRound() {
        return {
          kind: 'compacted',
          providerRoundAnchorEntryId: 'entry-before-compaction',
          providerUsageTelemetry: {
            inputTokens: 300,
            outputTokens: 25,
            cachedInputTokens: 100,
          },
        };
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-usage',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...finalRound,
        durableRequest: {
          requestIdentity: 'b'.repeat(64),
          providerRequestAttempt: 0,
          transportKind: 'websocket',
          resumed: false,
        },
        events: [
          ...(finalRound.events ?? []),
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 9_800,
                output_tokens: 252,
                input_tokens_details: { cached_tokens: 4_000 },
              },
            },
          },
        ],
      },
    ]),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.ok, true);
  const usageEvents = events.filter((event) => event.type === 'usage_updated');
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents[0]?.payload, {
    inputTokens: 9_800,
    outputTokens: 252,
    cachedInputTokens: 4_000,
  });
  assert.deepEqual(usageEvents[1]?.payload, {
    inputTokens: 10_100,
    outputTokens: 277,
    cachedInputTokens: 4_100,
  });
  // 런 상태의 누적치와 이벤트 페이로드가 일치한다 (스냅샷 복사)
  assert.deepEqual(runState.usageTotals, {
    inputTokens: 10_100,
    outputTokens: 277,
    cachedInputTokens: 4_100,
  });
});

void test('runAgentLoop persists approval denial as transcripted terminal failure', async () => {
  const threadId = testThreadId(1);
  const runId = testRunId('loop-denied');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-denied-'));
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  registerOnce(
    daemonContext,
    makePathArgumentTestTool({
      name: 'loop_integration_denied_tool',
      description: 'approval denied integration test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not execute' };
      },
    }),
  );

  const events: AgentEvent[] = [];
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'please write the file',
    runState,
    toolSurface: {
      directRegistryNames: ['loop_integration_denied_tool'],
      allowedRegistryNames: ['loop_integration_denied_tool'],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-denied',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerToolRound({
        toolName: 'loop_integration_denied_tool',
      }),
    ]),
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval_required') {
        setTimeout(() => {
          void daemonContext.approvalGate.resolveApproval(
            event.payload.callId,
            event.payload.runId,
            event.payload.threadId,
            'denied',
          );
        }, 0);
      }
    },
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'failed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'approval_required',
      'tool_result',
      'error',
    ],
  );
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  assert.match(transcript[1]?.content ?? '', /approval_denied/);
});

void test('runAgentLoop completes after approved tool execution and second-round final answer', async () => {
  const threadId = testThreadId(2);
  const runId = testRunId('loop-success');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-success-'));
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  registerOnce(
    daemonContext,
    makePathArgumentTestTool({
      name: 'loop_integration_success_tool',
      description: 'approved integration test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'tool ok' };
      },
    }),
  );

  const events: AgentEvent[] = [];
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });
  const callModelImpl = createScriptedProviderCallModel([
    providerToolRound({
      toolName: 'loop_integration_success_tool',
    }),
    providerFinalAnswerRound('final answer'),
  ]);

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'please run the tool and finish',
    runState,
    toolSurface: {
      directRegistryNames: ['loop_integration_success_tool'],
      allowedRegistryNames: ['loop_integration_success_tool'],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-success',
    }),
    callModelImpl,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval_required') {
        setTimeout(() => {
          void daemonContext.approvalGate.resolveApproval(
            event.payload.callId,
            event.payload.runId,
            event.payload.threadId,
            'approved',
          );
        }, 0);
      }
    },
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'final answer',
  });
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'approval_required',
      'tool_result',
      'final_answer_delta',
    ],
  );
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  assert.match(transcript[1]?.content ?? '', /tool ok/);
});

void test('runAgentLoop applies pending interject before the next steer-aware durable model round', async (t) => {
  const threadId = testThreadId(1201);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-interject-run-'),
  );
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const events: AgentEvent[] = [];
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-interject',
    runContext,
  });
  await daemonContext.runCheckpoints.startRun({
    runId: runState.runId,
    threadId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  let injected = false;
  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('first answer'),
      durableRequest: {
        requestIdentity: 'c'.repeat(64),
        providerRequestAttempt: 0,
        transportKind: 'websocket',
        resumed: false,
      },
      inspectInput(input) {
        assert.equal(
          input.history.some(
            (item) => item.kind === 'user' && item.text === 'please revise',
          ),
          false,
        );
      },
    },
    {
      ...providerFinalAnswerRound('second answer'),
      durableRequest: {
        requestIdentity: 'd'.repeat(64),
        providerRequestAttempt: 0,
        transportKind: 'websocket',
        resumed: false,
      },
      inspectInput(input) {
        const userTurns = input.history
          .filter((item) => item.kind === 'user')
          .map((item) => item.text);
        assert.deepEqual(userTurns, ['please answer once', 'please revise']);
        // 즉시 반영은 라운드를 스트리밍 도중에 끊는다. 그래서 첫 라운드는
        // provider가 완결한 backend_item을 남기지 못하고, 끊긴 시점까지
        // 모델이 한 말이 assistant 항목으로 남는다 — 화면에 이미 흘렀으므로
        // 히스토리에서 지우면 다음 라운드가 그 말을 안 한 것처럼 이어간다.
        const firstProviderItem = input.history[1];
        assert.equal(firstProviderItem?.kind, 'assistant');
        if (firstProviderItem?.kind !== 'assistant') {
          return;
        }
        assert.equal(firstProviderItem.text, 'first answer');
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-interject',
    runContext,
    prompt: 'please answer once',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-interject',
    }),
    callModelImpl,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'final_answer_delta' && !injected) {
        injected = true;
        pushPendingInterject(runState.interject, 'please revise');
        requestInterjectFlush(runState.interject);
      }
    },
  });

  assert.equal(injected, true);
  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'second answer');
  assert.match(result.modelSettlementIdentity ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'final_answer_delta',
      'interject_applied',
      'final_answer_delta',
    ],
  );
  const applied = events.find((event) => event.type === 'interject_applied');
  assert.deepEqual(applied?.payload, {
    runId: 'run-loop-interject',
    count: 1,
    receivedSeqs: [1],
  });
  // 소비 시점에 즉시 반영 요청이 1회성으로 지워진다
  assert.equal(isInterjectFlushRequested(runState.interject), false);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => ({
      role: entry.role,
      content: entry.content,
      source: entry.metadata?.source,
    })),
    [
      {
        role: 'user',
        content: 'please revise',
        source: 'interject',
      },
    ],
  );
});

void test('runAgentLoop reconciles a transcript-persisted applying interject exactly once after restart', async () => {
  const threadId = testThreadId(1206);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-interject-restart-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const runState = createRunState({
    runId: 'run-loop-interject-restart',
    runContext,
  });
  const interject = { receivedSeq: 1, text: 'resume with this steer' };
  await daemonContext.runCheckpoints.startRun({
    runId: runState.runId,
    threadId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  await daemonContext.runCheckpoints.enqueueInterject({
    threadId,
    runId: runState.runId,
    interject,
  });
  await daemonContext.runCheckpoints.claimInterject({
    threadId,
    runId: runState.runId,
    receivedSeq: interject.receivedSeq,
  });
  await persistSingleInterjectToTranscript(
    workspaceRoot,
    threadId,
    runState.runId,
    interject,
  );
  restorePendingInterjectFront(runState.interject, [interject], 1);
  const history: HistoryItem[] = [
    { kind: 'user', text: 'resume with this steer' },
  ];

  const result = await runAgentLoop({
    runId: runState.runId,
    runContext,
    prompt: 'resume with this steer',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-interject-restart',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerFinalAnswerRound('recovered answer'),
        inspectInput(input) {
          assert.deepEqual(
            input.history
              .filter((item) => item.kind === 'user')
              .map((item) => item.text),
            ['resume with this steer'],
          );
        },
      },
    ]),
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'recovered answer' });
  assert.equal(history.length, 2);
  assert.deepEqual(
    await daemonContext.runCheckpoints
      .readThread(threadId)
      .then((checkpoint) =>
        checkpoint === null
          ? null
          : {
              applyingInterject: checkpoint.applyingInterject,
              pendingInterjects: checkpoint.pendingInterjects,
            },
      ),
    { applyingInterject: null, pendingInterjects: [] },
  );
  assert.equal(
    (await readTranscriptEntries(workspaceRoot, threadId)).length,
    1,
  );
});

void test('runAgentLoop continues across tool rounds through the while loop', async () => {
  const toolName = 'loop_integration_while_loop_tool';
  const threadId = testThreadId(1203);
  const daemonContext = createDaemonContext();
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makePathArgumentTestTool({
      name: toolName,
      description: 'while-loop regression test tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'tool ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-while-rounds-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-while-rounds',
    runContext,
  });
  const toolCallIds = ['call-a', 'call-b', 'call-c'];
  const toolRounds = toolCallIds.map((callId, index) =>
    providerToolRound({
      toolName,
      messageId: `msg-${index}`,
      functionCallId: `fc-${index}`,
      callId,
    }),
  );

  const result = await runAgentLoop({
    runId: 'run-loop-while-rounds',
    runContext,
    prompt: 'keep using the tool before answering',
    runState,
    toolSurface: {
      directRegistryNames: [toolName],
      allowedRegistryNames: [toolName],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-while-rounds',
    }),
    callModelImpl: createScriptedProviderCallModel([
      ...toolRounds,
      providerFinalAnswerRound('finished after tool rounds', {
        itemId: 'msg-final',
      }),
    ]),
    onEvent() {},
  });

  assert.equal(executionCount, toolCallIds.length);
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'finished after tool rounds',
  });
  assert.equal(runState.status, 'completed');
});
