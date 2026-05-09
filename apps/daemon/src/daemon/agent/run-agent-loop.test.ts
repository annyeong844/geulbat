import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAgentLoop } from './run-agent-loop.js';
import type { AgentEvent } from './events.js';
import { createThreadBackgroundNotificationQueue } from './runtime/background-notification-queue.js';
import { createRunState } from './runtime/run-state.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { createResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-session.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

function registerOnce(
  daemonContext: ReturnType<typeof createDaemonContext>,
  tool: AnyTool,
): void {
  daemonContext.toolRegistry.registerTool(tool);
}

function parseObjectArgs<TArgs extends object>(
  raw: unknown,
): ToolParseResult<TArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'tool arguments must be an object.' };
  }
  return { ok: true, value: raw as TArgs };
}

function makeTestTool<TArgs extends object = Record<string, unknown>>(args: {
  name: string;
  description: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  requiresApproval: boolean;
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}): AnyTool {
  return {
    name: args.name,
    description: args.description,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

void test('runAgentLoop persists approval denial as transcripted terminal failure', async () => {
  const threadId = testThreadId(1);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'loop_integration_denied_tool',
      description: 'approval denied integration test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not execute' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-denied-'));
  const events: AgentEvent[] = [];
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-denied',
    runContext,
  });

  const result = await runAgentLoop({
    runId: 'run-loop-denied',
    runContext,
    prompt: 'please write the file',
    runState,
    allowedToolNames: ['loop_integration_denied_tool'],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-denied',
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
          daemonContext.approvalGate.resolveApproval(
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
    events.map((event) => event.type),
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
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'loop_integration_success_tool',
      description: 'approved integration test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'tool ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-success-'));
  const events: AgentEvent[] = [];
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-success',
    runContext,
  });
  const callModelImpl = createScriptedProviderCallModel([
    providerToolRound({
      toolName: 'loop_integration_success_tool',
    }),
    providerFinalAnswerRound('final answer'),
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-success',
    runContext,
    prompt: 'please run the tool and finish',
    runState,
    allowedToolNames: ['loop_integration_success_tool'],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-success',
    }),
    callModelImpl,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval_required') {
        setTimeout(() => {
          daemonContext.approvalGate.resolveApproval(
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
    events.map((event) => event.type),
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

void test('runAgentLoop surfaces a legacy artifact candidate separately from final answer text', async () => {
  const threadId = testThreadId(201);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-artifact-candidate-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-artifact-candidate',
    runContext,
  });
  const events: AgentEvent[] = [];
  const answer =
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->';

  const result = await runAgentLoop({
    runId: 'run-loop-artifact-candidate',
    runContext,
    prompt: 'finish with an artifact',
    runState,
    allowedToolNames: [],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-artifact-candidate',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound(answer),
    ]),
    onEvent: (event) => {
      events.push(event);
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
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack'],
  );
});

void test('runAgentLoop can consume pending background results from an injected queue', async () => {
  const threadId = testThreadId(3);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-background-note-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const notifications = createThreadBackgroundNotificationQueue();
  notifications.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-background-1',
    parentRunId: testRunId('parent-background-1'),
    childRunId: testRunId('child-background-1'),
    subagentType: 'explorer',
    terminalState: 'failed',
    result: 'background child failed',
    completedAt: '2026-03-30T00:00:01.000Z',
  });

  let seenSystemPrompt = '';
  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('background noted'),
      inspectInput(input) {
        seenSystemPrompt = input.systemPrompt;
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-background-note',
    runContext,
    prompt: 'summarize background work',
    runtimeServices: {
      ...daemonContext,
      backgroundNotifications: notifications,
    },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-background-note',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'background noted',
  });
  assert.match(seenSystemPrompt, /Background child updates:/);
  assert.match(seenSystemPrompt, /type: explorer/);
  assert.match(seenSystemPrompt, /background child failed/);
  assert.equal(
    notifications.consumeThreadBackgroundResults(threadId).length,
    0,
  );
});

void test('runAgentLoop forwards an injected provider websocket session store', async () => {
  const threadId = testThreadId(4);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-ws-store-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const providerWebSocketSessions = createResponsesWebSocketSessionStore();
  let seenStore:
    | { acquireWebSocket: typeof providerWebSocketSessions.acquireWebSocket }
    | undefined;

  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('store forwarded'),
      inspectInput(input) {
        seenStore = input.providerWebSocketSessions;
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-provider-ws-store',
    runContext,
    prompt: 'use injected websocket store',
    runtimeServices: {
      ...daemonContext,
      providerWebSocketSessions,
    },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-provider-ws-store',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'store forwarded',
  });
  assert.equal(seenStore, providerWebSocketSessions);
});

void test('runAgentLoop can use runtime service defaults for background results and websocket sessions', async () => {
  const threadId = testThreadId(5);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-daemon-context-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const daemonContext = createDaemonContext();
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    threadId,
    {
      deliveryId: 'delivery-context-note-1',
      parentRunId: testRunId('parent-context-note-1'),
      childRunId: testRunId('child-context-note-1'),
      subagentType: 'explorer',
      terminalState: 'failed',
      result: 'context child failed',
      completedAt: '2026-03-30T00:00:01.000Z',
    },
  );

  let seenSystemPrompt = '';
  let seenStore:
    | {
        acquireWebSocket: typeof daemonContext.providerWebSocketSessions.acquireWebSocket;
      }
    | undefined;
  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('context noted'),
      inspectInput(input) {
        seenSystemPrompt = input.systemPrompt;
        seenStore = input.providerWebSocketSessions;
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-daemon-context',
    runContext,
    prompt: 'summarize context work',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-daemon-context',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'context noted',
  });
  assert.match(seenSystemPrompt, /Background child updates:/);
  assert.match(seenSystemPrompt, /context child failed/);
  assert.equal(seenStore, daemonContext.providerWebSocketSessions);
});
