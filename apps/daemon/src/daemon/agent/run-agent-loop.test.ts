import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';
import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '@geulbat/protocol/provider-auth';
import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import { runAgentLoop } from './run-agent-loop.js';
import { createAgentLoopPromptPort } from './loop-prompt.js';
import type { AgentEvent } from './events.js';
import { createThreadBackgroundNotificationQueue } from './runtime/background-notification-queue.js';
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
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { createResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
import type { ResponsesRequestMeasurement } from '../llm/provider/transport/responses-websocket.js';
import { ProviderReplayScopeMismatchError } from '../llm/provider/provider-replay-scope.js';
import type { HistoryItem } from '../llm/index.js';
import type { AgentLoopObserverSnapshot } from './observer/agent-loop-observer.js';
import type { PtcFixedEpochProbeRuntime } from '../daemon-runtime-contract.js';
import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
  type PtcBrowserPageLoadEvidenceRuntime,
} from '../ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import {
  PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
  type PtcBrowserTextEvidenceRuntime,
} from '../ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import {
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
  type PtcBrowserNavigateRuntime,
} from '../ptc/runtime/browser/browser-navigate-runtime-contract.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  type PtcFixedEpochProbeRuntimeSummary,
} from '../ptc/runtime/probes/fixed-probe-runtime-contract.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  composeProviderRounds,
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerStructuredOutputRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
} from './ptc-fixed-probe-structured-output-caller.js';

function withoutProviderStatus(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type !== 'provider_status');
}

function registerOnce(
  daemonContext: ReturnType<typeof createDaemonContext>,
  tool: AnyTool,
): void {
  daemonContext.toolRegistry.registerTool(tool);
}

async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: ReturnType<typeof testRunId>,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: '.', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
}

const STRUCTURED_NO_DEPENDENCY_REQUEST = {
  entryUrl: 'https://fixtures.geulbat.local/no-deps.js',
  runtimeDependencies: {},
  dependencyRefs: [],
};

function structuredReactBundleOutput(payload: unknown) {
  return {
    schemaVersion: 1,
    kind: 'react_bundle_explicit_cdn_artifact',
    payload,
  };
}

function structuredPtcFixedProbeOutput() {
  return {
    schemaVersion: 1,
    kind: PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
    payload: {
      probeId: PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
    },
  };
}

function createTestContextBudgetRound(
  onContextUsage?: (snapshot: ContextUsageUpdatedEventPayload) => void,
) {
  let requestBytes: number | undefined;
  return {
    onProviderRequestPrepared(measurement: ResponsesRequestMeasurement) {
      requestBytes = measurement.serializedBytes;
    },
    async prepareBeforeModelRound() {
      return { kind: 'failed' as const, message: 'not requested by this test' };
    },
    getRequestBytes() {
      return requestBytes;
    },
    getToolResultContextBudget() {
      return {
        kind: 'unknown' as const,
        modelKey: 'test\0test',
        reason: 'usage_unavailable' as const,
      };
    },
    publish(snapshot: ContextUsageUpdatedEventPayload) {
      onContextUsage?.(snapshot);
    },
  };
}

function testRequestMeasurement(
  serializedBytes: number,
): ResponsesRequestMeasurement {
  return {
    serializedBytes,
    dominantPressureSource: 'history',
    serializedBytesBySource: {
      history: serializedBytes,
      instructions: 0,
      toolDefinitions: 0,
      envelope: 0,
    },
  };
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
    mayMutateComputerFiles: false,
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

void test('runAgentLoop rejects direct tools outside the allowed registry surface', async () => {
  const threadId = testThreadId(0);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-invalid-tool-surface-'),
  );
  const events: AgentEvent[] = [];
  let modelCallCount = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-invalid-tool-surface',
    runContext: makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    prompt: 'do not start this run',
    toolSurface: {
      directRegistryNames: ['write_file'],
      allowedRegistryNames: [],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-invalid-tool-surface',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerFinalAnswerRound('should not run'),
        inspectInput() {
          modelCallCount += 1;
        },
      },
    ]),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(modelCallCount, 0);
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack', 'error'],
  );
  const terminalEvent = events.at(-1);
  assert.equal(terminalEvent?.type, 'error');
  if (terminalEvent?.type !== 'error') {
    throw new Error('expected terminal error event');
  }
  assert.match(
    terminalEvent.payload.message,
    /direct tool is outside the allowed registry surface: write_file/,
  );
});

void test('runAgentLoop rejects ambiguous or unknown explicit capability authority before model execution', async () => {
  const threadId = testThreadId(2);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-invalid-tool-capability-policy-'),
  );
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files'],
    callbackRegistryNames: [],
    writeCallbackEnabled: false,
  });
  let modelCallCount = 0;

  const ambiguous = await runAgentLoop({
    runId: 'run-loop-ambiguous-tool-capability-policy',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'do not start this run',
    toolSurface: {
      directRegistryNames: ['list_files'],
      allowedRegistryNames: ['list_files'],
    },
    toolCapabilityPolicy,
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-ambiguous-tool-capability-policy',
    }),
    modelRoundPort: {
      async runModelRound() {
        modelCallCount += 1;
        assert.fail('ambiguous tool authority must stop before the model');
      },
    },
    onEvent() {},
  });
  const unknown = await runAgentLoop({
    runId: 'run-loop-unknown-tool-capability-policy',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'do not start this run either',
    toolCapabilityPolicy: createToolCapabilityPolicy({
      directRegistryNames: [],
      allowedRegistryNames: ['unknown_policy_tool'],
      callbackRegistryNames: [],
      writeCallbackEnabled: false,
    }),
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-unknown-tool-capability-policy',
    }),
    modelRoundPort: {
      async runModelRound() {
        modelCallCount += 1;
        assert.fail('unknown tool authority must stop before the model');
      },
    },
    onEvent() {},
  });

  assert.deepEqual(ambiguous, { ok: false, finalProse: '' });
  assert.deepEqual(unknown, { ok: false, finalProse: '' });
  assert.equal(modelCallCount, 0);
});

void test('runAgentLoop composes one explicit tool capability policy across definitions, projection, execution, and observation', async () => {
  const threadId = testThreadId(1);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-tool-capability-policy-'),
  );
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const definitionAdmissions: Array<readonly string[] | undefined> = [];
  const projectionPolicies: unknown[] = [];
  const executionPolicies: unknown[] = [];
  const executionAllowedRegistryNames: Array<readonly string[] | undefined> =
    [];
  const promptDirectRegistryNames: Array<readonly string[] | undefined> = [];
  const snapshots: AgentLoopObserverSnapshot[] = [];
  let modelRound = 0;
  const promptPort = createAgentLoopPromptPort();

  const result = await runAgentLoop({
    runId: 'run-loop-tool-capability-policy',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'use the bounded tool policy',
    toolCapabilityPolicy,
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-tool-capability-policy',
    }),
    promptPort: {
      buildPromptBundle(args) {
        promptDirectRegistryNames.push(args.directRegistryNames);
        return promptPort.buildPromptBundle(args);
      },
    },
    toolDefinitionPort: {
      buildToolDefinitions(args) {
        definitionAdmissions.push(args.directRegistryNames);
        return daemonContext.toolRegistry.buildToolDefinitions({
          names: [...(args.directRegistryNames ?? [])],
        });
      },
    },
    toolLibraryProjectionPort: {
      async resolveProjection(args) {
        projectionPolicies.push(args.toolCapabilityPolicy);
        return {
          ok: true,
          identity: {
            sdkVersion: 'sdk-policy-test',
            sdkProjectionHash:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            policyId: toolCapabilityPolicy.toolCapabilityPolicyId,
          },
        };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc-policy-list-files',
                  callId: 'call-policy-list-files',
                  name: 'list_files',
                  arguments: '{}',
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'bounded policy complete',
            terminalResult: {
              ok: true,
              finalProse: 'bounded policy complete',
            },
            functionCalls: [],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        executionPolicies.push(args.toolCapabilityPolicy);
        executionAllowedRegistryNames.push(args.allowedRegistryNames);
        return { ok: true, value: undefined };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'bounded policy complete',
  });
  assert.deepEqual(definitionAdmissions, [['list_files']]);
  assert.deepEqual(promptDirectRegistryNames, [['list_files']]);
  assert.deepEqual(projectionPolicies, [toolCapabilityPolicy]);
  assert.deepEqual(executionPolicies, [toolCapabilityPolicy]);
  assert.deepEqual(executionAllowedRegistryNames, [
    ['list_files', 'read_file'],
  ]);
  assert.deepEqual(snapshots[0]?.toolSurface.admission, {
    kind: 'restricted',
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files', 'read_file'],
  });
  assert.equal(
    snapshots[0]?.toolSurface.toolLibraryProjection?.policyId,
    toolCapabilityPolicy.toolCapabilityPolicyId,
  );
});

void test('runAgentLoop executes the tool identity captured before the model round', async () => {
  const threadId = testThreadId(1220);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-tool-registry-snapshot-'),
  );
  let originalExecutions = 0;
  let replacementExecutions = 0;
  let modelRound = 0;
  const toolName = 'run_snapshot_tool';

  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'original run tool',
      sideEffectLevel: 'none',
      requiresApproval: false,
      async executeParsed() {
        originalExecutions += 1;
        return { ok: true, output: 'original run tool result' };
      },
    }),
  );

  const result = await runAgentLoop({
    runId: 'run-loop-tool-registry-snapshot',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'use the snapshotted tool',
    toolSurface: {
      directRegistryNames: [toolName],
      allowedRegistryNames: [toolName],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-tool-registry-snapshot',
      permissionMode: 'full_access',
    }),
    toolLibraryProjectionPort: {
      async resolveProjection() {
        return {
          ok: true,
          identity: {
            sdkVersion: 'sdk-run-snapshot-test',
            sdkProjectionHash:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            policyId: 'run-snapshot-test',
          },
        };
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        modelRound += 1;
        if (modelRound === 1) {
          assert.deepEqual(
            args.toolDefs.map(({ name, description }) => ({
              name,
              description,
            })),
            [{ name: toolName, description: 'original run tool' }],
          );
          assert.equal(
            daemonContext.toolRegistry.unregisterTool(toolName),
            true,
          );
          daemonContext.toolRegistry.registerTool(
            makeTestTool({
              name: toolName,
              description: 'replacement run tool',
              sideEffectLevel: 'write',
              requiresApproval: true,
              async executeParsed() {
                replacementExecutions += 1;
                return { ok: true, output: 'replacement run tool result' };
              },
            }),
          );
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc-run-snapshot-tool',
                  callId: 'call-run-snapshot-tool',
                  name: toolName,
                  arguments: '{}',
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'snapshot complete',
            terminalResult: {
              ok: true,
              finalProse: 'snapshot complete',
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
    finalProse: 'snapshot complete',
  });
  assert.equal(modelRound, 2);
  assert.equal(originalExecutions, 1);
  assert.equal(replacementExecutions, 0);
  assert.equal(
    daemonContext.toolRegistry
      .captureSnapshot()
      .buildToolDefinitions({ names: [toolName] })[0]?.description,
    'replacement run tool',
  );
});

void test('runAgentLoop ends a turn only after a successful turn-ending tool result', async () => {
  const threadId = testThreadId(1211);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-turn-ending-tool-'),
  );
  const outcomes = ['failure', 'success'] as const;
  let modelRound = 0;
  let toolRound = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-turn-ending-tool',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'ask one question',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-turn-ending-tool',
    }),
    toolDefinitionPort: {
      buildToolDefinitions() {
        return daemonContext.toolRegistry.buildToolDefinitions({
          names: ['ask_user'],
        });
      },
    },
    toolLibraryProjectionPort: {
      async resolveProjection() {
        return {
          ok: true,
          identity: {
            sdkVersion: 'sdk-turn-ending-tool-test',
            sdkProjectionHash:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            policyId: 'turn-ending-tool-test',
          },
        };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        assert.ok(modelRound <= 2, 'a successful ask_user must end the turn');
        return {
          ok: true,
          value: {
            assistantText: '',
            terminalResult: {
              ok: true,
              finalProse: `waiting-round-${modelRound}`,
            },
            functionCalls: [
              {
                id: `fc-ask-user-${modelRound}`,
                callId: `call-ask-user-${modelRound}`,
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
        const outcome = outcomes[toolRound];
        assert.ok(outcome);
        toolRound += 1;
        args.observeToolResult?.({
          schemaVersion: 1,
          runId: args.runId,
          threadId: args.runContext.threadId,
          callId: args.functionCalls[0]?.callId ?? '',
          toolName: 'ask_user',
          outcome,
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
  assert.equal(toolRound, 2);
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'waiting-round-2',
  });
});

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

void test('runAgentLoop exposes update_goal only in Goal mode and completes after a two-vote quorum', async () => {
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
  let verifierCalls = 0;
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
        if (modelRound === 2) {
          assert.equal(
            history.some(
              (item) =>
                item.kind === 'assistant' &&
                item.text.includes('"kind":"goal_completion_assessment"') &&
                item.text.includes('Finish the remaining verification'),
            ),
            true,
          );
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
                  id: 'fc-goal-complete-again',
                  callId: 'call-goal-complete-again',
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
              item.text.includes('"kind":"goal_completion_verified"'),
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
    goalCompletionVerifier: {
      async verify(args) {
        verifierCalls += 1;
        assert.equal(args.goal.state, 'verifying');
        if (verifierCalls === 1) {
          return {
            outcome: {
              kind: 'incomplete',
              unmetRequirements: ['Finish the remaining verification'],
            },
            votes: [
              {
                verdict: 'not_achieved',
                unmetRequirements: ['Finish the remaining verification'],
              },
              {
                verdict: 'not_achieved',
                unmetRequirements: ['Finish the remaining verification'],
              },
              { verdict: 'achieved' },
            ],
          };
        }
        return {
          outcome: { kind: 'achieved' },
          votes: [
            { verdict: 'achieved' },
            { verdict: 'achieved' },
            {
              verdict: 'not_achieved',
              unmetRequirements: ['Dissenting check'],
            },
          ],
        };
      },
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(modelRound, 3);
  assert.equal(verifierCalls, 2);
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
    ['verifying', 'continuing', 'verifying', 'completed'],
  );
});

void test('runAgentLoop does not expose or invoke Goal completion verification in ordinary chat', async () => {
  const threadId = testThreadId(1215);
  const runId = testRunId(1215);
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-no-goal-'));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  let verifierCalls = 0;

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
    goalCompletionVerifier: {
      async verify() {
        verifierCalls += 1;
        return {
          outcome: { kind: 'achieved' },
          votes: [
            { verdict: 'achieved' },
            { verdict: 'achieved' },
            { verdict: 'achieved' },
          ],
        };
      },
    },
    onEvent() {},
  });

  assert.equal(verifierCalls, 0);
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

void test('runAgentLoop accumulates model-round and compaction usage in emission order', async () => {
  const threadId = testThreadId(77);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-usage-'));
  const events: AgentEvent[] = [];
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({ runId: 'run-loop-usage', runContext });

  const finalRound = providerFinalAnswerRound('usage done');
  const result = await runAgentLoop({
    runId: 'run-loop-usage',
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

void test('runAgentLoop projects a run-selected model to its provider round', async () => {
  const threadId = testThreadId(31);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-provider-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  let observedProviderId: string | undefined;
  let observedModel: string | undefined;
  let observedReasoningEffort: string | undefined;
  let observedServiceTier: string | undefined;

  const result = await runAgentLoop({
    runId: 'run-loop-provider',
    runContext,
    prompt: 'hello grok',
    providerModel: {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
    },
    reasoningEffort: 'high',
    serviceTier: 'standard',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider',
    }),
    modelRoundPort: {
      async runModelRound(args) {
        observedProviderId = args.providerRequestOptions.providerId;
        observedModel = args.providerRequestOptions.model;
        observedReasoningEffort = args.providerRequestOptions.reasoning.effort;
        observedServiceTier = args.providerRequestOptions.serviceTier;
        return {
          ok: true,
          value: {
            assistantText: 'provider ok',
            terminalResult: {
              ok: true,
              finalProse: 'provider ok',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'provider ok' });
  assert.equal(observedProviderId, 'grok_oauth');
  assert.equal(observedModel, 'grok-4.5');
  assert.equal(observedReasoningEffort, 'high');
  assert.equal(observedServiceTier, 'standard');
});

void test('runAgentLoop wires the runtime memory owner into pre-dispatch preparation', async () => {
  const threadId = testThreadId(311);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-context-preparation-'),
  );
  let preparationCalls = 0;
  let postRoundCalls = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-context-preparation',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue safely',
    runtimeServices: {
      ...daemonContext,
      agent: {
        ...daemonContext.agent,
        loopMemory: {
          beginContextBudgetRound(args) {
            assert.equal(args.threadId, threadId);
            return {
              onProviderRequestPrepared(measurement) {
                assert.equal(measurement.serializedBytes, 256);
                return { kind: 'prepare', reason: 'near_policy' };
              },
              async prepareBeforeModelRound() {
                preparationCalls += 1;
                return { kind: 'prepared' };
              },
              getRequestBytes() {
                return 256;
              },
              getToolResultContextBudget() {
                return {
                  kind: 'unknown',
                  modelKey: 'test\0test',
                  reason: 'usage_unavailable',
                };
              },
              publish() {},
            };
          },
          async compactAfterModelRound() {
            postRoundCalls += 1;
            return { kind: 'not_needed', reason: 'under_threshold' };
          },
        },
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-context-preparation',
    }),
    modelRoundPort: {
      async runModelRound(args) {
        assert.ok(args.onProviderRequestPrepared);
        assert.deepEqual(
          await args.onProviderRequestPrepared(testRequestMeasurement(256)),
          { kind: 'prepare', reason: 'near_policy' },
        );
        assert.ok(args.onContextPreparationRequired);
        assert.deepEqual(await args.onContextPreparationRequired(), {
          kind: 'prepared',
        });
        return {
          ok: true,
          value: {
            assistantText: 'prepared',
            terminalResult: { ok: true, finalProse: 'prepared' },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'prepared' });
  assert.equal(preparationCalls, 1);
  assert.equal(postRoundCalls, 1);
});

void test('runAgentLoop hands the completed model budget to the same-round tool owner after appending calls', async () => {
  const threadId = testThreadId(1311);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-tool-result-budget-'),
  );
  let modelRound = 0;
  let budgetReadAfterCallAppend = false;
  let observedBudget: unknown;

  const result = await runAgentLoop({
    runId: 'run-loop-tool-result-budget',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'measure the tool round',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-tool-result-budget',
    }),
    memoryPort: {
      beginContextBudgetRound(args) {
        return {
          onProviderRequestPrepared() {},
          async prepareBeforeModelRound() {
            return { kind: 'prepared' };
          },
          getRequestBytes() {
            return 1_000;
          },
          getToolResultContextBudget() {
            budgetReadAfterCallAppend = args.history.some(
              (item) =>
                item.kind === 'function_call' &&
                item.callId === 'call-tool-result-budget',
            );
            return {
              kind: 'available',
              quality: 'exact',
              modelKey: 'openai_codex_direct\0gpt-test',
              availableRequestBytes: 700,
            };
          },
          publish() {},
        };
      },
      async compactAfterModelRound() {
        return { kind: 'not_needed', reason: 'under_threshold' };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc-tool-result-budget',
                  callId: 'call-tool-result-budget',
                  name: 'list_files',
                  arguments: '{}',
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, finalProse: 'done' },
            functionCalls: [],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        observedBudget = args.toolResultContextBudget;
        return { ok: true, value: undefined };
      },
    },
    onEvent() {},
  });

  assert.equal(budgetReadAfterCallAppend, true);
  assert.deepEqual(observedBudget, {
    kind: 'available',
    quality: 'exact',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 700,
  });
  assert.deepEqual(result, { ok: true, finalProse: 'done' });
});

void test('runAgentLoop exposes one consent-backed cross-provider overflow recovery', async () => {
  const threadId = testThreadId(312);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-transition-recovery-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'continue' }];
  let recoveryCalls = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-provider-transition-recovery',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    providerModel: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-luna',
    },
    providerTransitionRecovery: {
      sourceModelId: 'grok-4.5',
      sourceReasoningEffort: 'high',
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-transition-recovery',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        assert.ok(args.onContextOverflow);
        assert.equal(await args.onContextOverflow(), true);
        assert.equal(await args.onContextOverflow(), false);
        assert.deepEqual(args.history, [
          { kind: 'user', text: 'portable handoff' },
          { kind: 'user', text: 'continue' },
        ]);
        return {
          ok: true,
          value: {
            assistantText: 'continued',
            terminalResult: { ok: true, finalProse: 'continued' },
            functionCalls: [],
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async recoverProviderTransitionAfterOverflow(args) {
        recoveryCalls += 1;
        assert.equal(args.workspaceRoot, workspaceRoot);
        assert.equal(args.threadId, threadId);
        assert.equal(args.prompt, 'continue');
        assert.deepEqual(args.source, {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        });
        assert.deepEqual(args.target, {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        });
        assert.equal(args.sourceReasoningEffort, 'high');
        args.history.splice(
          0,
          args.history.length,
          { kind: 'user', text: 'portable handoff' },
          { kind: 'user', text: 'continue' },
        );
        return true;
      },
      async compactAfterModelRound() {
        return { kind: 'not_needed', reason: 'under_threshold' };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'continued' });
  assert.equal(recoveryCalls, 1);
});

void test('runAgentLoop keeps prior tool output bytes immutable after successful model consumption', async () => {
  const threadId = testThreadId(32);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-output-'));
  const outputRef = `tool-output:${threadId}/run-previous/call-previous`;
  const originalOutput = JSON.stringify({
    status: 'exit',
    stdout: 'large output'.repeat(10_000),
    outputRef,
    fullOutputBytes: 120_000,
    fullOutputChars: 120_000,
  });
  const history: HistoryItem[] = [
    {
      kind: 'function_call',
      id: 'fc-previous',
      callId: 'call-previous',
      name: 'exec_command',
      arguments: '{"cmd":"rg pattern ."}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-previous',
      output: originalOutput,
    },
  ];
  let observedOutput = '';

  const result = await runAgentLoop({
    runId: 'run-loop-output-compaction',
    runContext: makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-output-compaction',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        const output = args.history.find(
          (item) => item.kind === 'function_call_output',
        );
        if (output?.kind === 'function_call_output') {
          observedOutput = output.output;
        }
        return {
          ok: true,
          value: {
            assistantText: 'consumed',
            terminalResult: { ok: true, finalProse: 'consumed' },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'consumed' });
  assert.equal(observedOutput, originalOutput);
  const retained = history.find((item) => item.kind === 'function_call_output');
  assert.equal(retained?.kind, 'function_call_output');
  if (retained?.kind !== 'function_call_output') {
    throw new Error('expected retained function_call_output');
  }
  assert.equal(retained.output, originalOutput);
});

void test('runAgentLoop preserves provider output items exactly once across a tool round', async () => {
  const threadId = testThreadId(1206);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-output-continuity-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'look it up' }];
  const events: AgentEvent[] = [];
  const observerRecords: unknown[] = [];
  const reasoningItem = {
    id: 'rs_round_1',
    type: 'reasoning',
    summary: [],
    encrypted_content: 'opaque-reasoning-checkpoint',
  };
  const functionCallItem = {
    id: 'fc_round_1',
    type: 'function_call',
    call_id: 'call_round_1',
    name: 'lookup',
    arguments: '{"query":"continuity"}',
    status: 'completed',
  };
  const finalMessageItem = {
    id: 'msg_round_2',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done' }],
  };
  const replayScopeId = `sha256:${'7'.repeat(64)}` as ProviderReplayScopeId;
  const providerItem = (data: unknown) => ({
    kind: 'backend_item' as const,
    data,
    providerReplayScopeId: replayScopeId,
  });
  let modelRound = 0;
  const result = await runAgentLoop({
    runId: 'run-loop-provider-output-continuity',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'look it up',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-output-continuity',
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
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc_round_1',
                  callId: 'call_round_1',
                  name: 'lookup',
                  arguments: '{"query":"continuity"}',
                },
              ],
              itemsToAppend: [
                providerItem(reasoningItem),
                providerItem(functionCallItem),
              ],
            },
          };
        }

        assert.deepEqual(history, [
          { kind: 'user', text: 'look it up' },
          providerItem(reasoningItem),
          providerItem(functionCallItem),
          {
            kind: 'function_call_output',
            callId: 'call_round_1',
            output: '{"result":"found"}',
          },
        ]);
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, finalProse: 'done' },
            functionCalls: [],
            itemsToAppend: [providerItem(finalMessageItem)],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        assert.deepEqual(args.history, [
          { kind: 'user', text: 'look it up' },
          providerItem(reasoningItem),
          providerItem(functionCallItem),
        ]);
        args.history.push({
          kind: 'function_call_output',
          callId: args.functionCalls[0]?.callId ?? '',
          output: '{"result":"found"}',
        });
        return { ok: true, value: undefined };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        observerRecords.push(snapshot);
      },
      recordEvent(event) {
        observerRecords.push(event);
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: true, finalProse: 'done' });
  assert.equal(modelRound, 2);
  assert.deepEqual(history, [
    { kind: 'user', text: 'look it up' },
    providerItem(reasoningItem),
    providerItem(functionCallItem),
    {
      kind: 'function_call_output',
      callId: 'call_round_1',
      output: '{"result":"found"}',
    },
    providerItem(finalMessageItem),
  ]);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.doesNotMatch(
    JSON.stringify({ events, observerRecords, transcript }),
    /opaque-reasoning-checkpoint/u,
  );
});

void test('runAgentLoop compacts successful round input before appending the new assistant tail', async () => {
  const threadId = testThreadId(1204);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-native-compaction-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'old context' }];
  let memoryCalls = 0;
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-native-compaction',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-native-compaction',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        await args.onProviderRequestPrepared?.(testRequestMeasurement(400));
        return {
          ok: true,
          value: {
            assistantText: 'new tail',
            terminalResult: { ok: true, finalProse: 'new tail' },
            functionCalls: [],
            providerUsageTelemetry: { inputTokens: 90 },
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async compactAfterModelRound(args) {
        memoryCalls += 1;
        assert.equal(args.inputTokens, 90);
        assert.equal(args.contextBudgetRound.getRequestBytes(), 400);
        assert.deepEqual(args.history, [{ kind: 'user', text: 'old context' }]);
        const contextUsage = {
          state: 'measured' as const,
          quality: 'exact' as const,
          modelId: args.providerRequestOptions.model,
          inputTokens: 90,
          contextWindow: 100,
          thresholdTokens: 90,
          requestBytes: 400,
        };
        args.contextBudgetRound.publish(contextUsage);
        args.history.splice(0, args.history.length, {
          kind: 'provider_native_compaction',
          providerId: 'openai_codex_direct',
          model: args.providerRequestOptions.model,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-checkpoint',
            },
          ],
        });
        args.contextBudgetRound.publish({
          ...contextUsage,
          state: 'compacted',
        });
        return {
          kind: 'compacted',
          providerRoundAnchorEntryId: 'unused-without-provider-items',
        };
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: true, finalProse: 'new tail' });
  assert.equal(memoryCalls, 1);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'context_usage_updated')
      .map((event) => event.payload.state),
    ['measured', 'compacted'],
  );
  assert.deepEqual(history, [
    {
      kind: 'provider_native_compaction',
      providerId: 'openai_codex_direct',
      model: daemonContext.provider.requestOptions.model,
      output: [
        {
          type: 'compaction',
          encrypted_content: 'opaque-checkpoint',
        },
      ],
    },
    { kind: 'assistant', phase: 'final_answer', text: 'new tail' },
  ]);
});

void test('runAgentLoop fails closed when a compaction transaction fails', async () => {
  const threadId = testThreadId(1205);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-compaction-failure-'),
  );
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-compaction-failure',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-compaction-failure',
    }),
    modelRoundPort: {
      async runModelRound() {
        return {
          ok: true,
          value: {
            assistantText: 'must not commit',
            terminalResult: { ok: true, finalProse: 'must not commit' },
            functionCalls: [],
            providerUsageTelemetry: { inputTokens: 90 },
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async compactAfterModelRound() {
        return {
          kind: 'failed',
          reason: 'stale_snapshot',
          message: 'context changed while compaction was being committed',
        };
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'error');
  if (terminal?.type === 'error') {
    assert.match(terminal.payload.message, /context_compaction_failed/u);
  }
});

void test('runAgentLoop applies pending interject before the next steer-aware model round', async () => {
  const threadId = testThreadId(1201);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-interject-run-'),
  );
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
      inspectInput(input) {
        const userTurns = input.history
          .filter((item) => item.kind === 'user')
          .map((item) => item.text);
        assert.deepEqual(userTurns, ['please answer once', 'please revise']);
        const firstProviderItem = input.history[1];
        assert.equal(firstProviderItem?.kind, 'backend_item');
        if (firstProviderItem?.kind !== 'backend_item') {
          return;
        }
        assert.ok(
          isProviderReplayScopeId(firstProviderItem.providerReplayScopeId),
        );
        assert.deepEqual(firstProviderItem.data, {
          id: 'msg_1',
          type: 'message',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'first answer' }],
        });
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
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'second answer',
  });
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
    makeTestTool({
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

void test('runAgentLoop surfaces a legacy artifact candidate separately from final answer text', async () => {
  const threadId = testThreadId(201);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-artifact-candidate-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-artifact-candidate',
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
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack', 'artifact_stream_delta'],
  );
});

void test('runAgentLoop routes structured react bundle output through typed ingress', async () => {
  const threadId = testThreadId(301);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-react-bundle-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-structured-react-bundle',
    runContext,
  });
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-structured-react-bundle',
    runContext,
    prompt: 'create a structured react bundle artifact',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-structured-react-bundle',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerStructuredOutputRound(
        structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
      ),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, '');
  assert.equal(result.artifactCandidate?.renderer, 'react_bundle');
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    daemonContext.sandboxAttempts
      .getAttempts()
      .records.map((attempt) => attempt.jobKind),
    ['react_bundle_dependency_prepare'],
  );
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack'],
  );
});

void test('runAgentLoop records structured output before applying a pending steer', async () => {
  const threadId = testThreadId(1202);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-interject-'),
  );
  const daemonContext = createDaemonContext({ homeStateRoot: workspaceRoot });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-structured-interject',
    runContext,
  });
  await daemonContext.runCheckpoints.startRun({
    runId: runState.runId,
    threadId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  const events: AgentEvent[] = [];
  let injected = false;

  const result = await runAgentLoop({
    runId: 'run-loop-structured-interject',
    runContext,
    prompt: 'create a structured react bundle artifact',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-structured-interject',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerStructuredOutputRound(
          structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
        ),
        inspectInput(input) {
          assert.equal(input.history.length, 1);
          if (!injected) {
            injected = true;
            pushPendingInterject(runState.interject, 'please revise artifact');
          }
        },
      },
      {
        ...providerFinalAnswerRound('revised artifact answer'),
        inspectInput(input) {
          assert.equal(
            input.history.some(
              (item) =>
                item.kind === 'assistant' &&
                item.phase === 'final_answer' &&
                item.text.includes('[artifact:react_bundle]'),
            ),
            true,
          );
          assert.equal(
            input.history.some(
              (item) =>
                item.kind === 'user' && item.text === 'please revise artifact',
            ),
            true,
          );
        },
      },
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(injected, true);
  assert.deepEqual(result, {
    ok: true,
    finalProse: 'revised artifact answer',
  });
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack', 'interject_applied', 'final_answer_delta'],
  );
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
        content: 'please revise artifact',
        source: 'interject',
      },
    ],
  );
});

void test('runAgentLoop routes structured PTC fixed probe output through daemon runtime', async () => {
  const threadId = testThreadId(302);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-ptc-fixed-probe-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-structured-ptc-fixed-probe',
    runContext,
  });
  const events: AgentEvent[] = [];
  const summary: PtcFixedEpochProbeRuntimeSummary = {
    ok: true,
    capabilityId: PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
    policyId: PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
    executionClass: 'fixed_docker_exec_probe',
    executionSurface: 'baked_image_node_eval',
    containerId: 'container-agent-loop-ptc-fixed-probe',
    epochId: 'ptc-epoch-agent-loop',
    callbackRoundTrip: 'observed',
    callbackResultKind: 'inline',
    exitCode: 0,
  };
  let observedRunContext: typeof runContext | undefined;
  const ptcFixedProbe: PtcFixedEpochProbeRuntime = {
    async runFixedEpochProbe(args) {
      observedRunContext = args.runContext;
      return { ok: true, value: summary };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-structured-ptc-fixed-probe',
    runContext,
    prompt: 'run the structured PTC fixed probe',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...daemonContext,
      ptc: { ...daemonContext.ptc, fixedProbe: ptcFixedProbe },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-structured-ptc-fixed-probe',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerStructuredOutputRound(structuredPtcFixedProbeOutput()),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observedRunContext, runContext);
  assert.match(result.finalProse, /callbackRoundTrip: observed/u);
  assert.match(
    result.finalProse,
    /capabilityId: ptc_fixed_epoch_execution_probe/u,
  );
  assert.equal(result.artifactCandidate, undefined);
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    daemonContext.sandboxAttempts
      .getAttempts()
      .records.map((attempt) => attempt.jobKind),
    [],
  );
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack'],
  );
  assert.doesNotMatch(result.finalProse, /container-agent-loop/u);
  assert.doesNotMatch(result.finalProse, /ptc-epoch-agent-loop/u);
});

void test('runAgentLoop exposes exec and wait as model-visible PTC tools', async () => {
  const threadId = testThreadId(330);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-execute-code-tool-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-execute-code-tool',
    runContext,
  });
  const events: AgentEvent[] = [];
  let observedCode = '';
  let observedRunContext:
    | Parameters<PtcExecuteCodeRuntime['executeCode']>[0]['runContext']
    | undefined;
  let observedCallbackToolNames: string[] | undefined;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedRunContext = args.runContext;
      observedCode = args.request.code;
      assert.equal(typeof args.toolCallbackHandler, 'function');
      observedCallbackToolNames = (args.sdkHelp?.callbackTools ?? []).map(
        (tool) => tool.name,
      );
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
          profile: 'lab',
          executionClass: 'lab_execute_code',
          executionSurface: 'node_via_lab_batch_command',
          exitCode: 0,
          stdout: '7\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          effectiveTimeoutMs: 1000,
          durationMs: 5,
          toolCallbacks: {
            enabled: true,
            observed: 0,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: 0,
          },
        },
      };
    },
    async waitForCell() {
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'missing',
          cellId: 'ptc_cell_unused',
          remediation: 'start_a_new_exec',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-execute-code-tool',
    runContext,
    prompt: 'run code',
    runState,
    toolSurface: {
      directRegistryNames: [
        PTC_EXECUTE_CODE_TOOL_NAME,
        PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
      ],
      allowedRegistryNames: [
        PTC_EXECUTE_CODE_TOOL_NAME,
        PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
      ],
    },
    runtimeServices: {
      ...daemonContext,
      ptc: { ...daemonContext.ptc, executeCode: ptcExecuteCode },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-execute-code-tool',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerToolRound({
          toolName: PTC_EXECUTE_CODE_TOOL_NAME,
          argumentsJson: JSON.stringify({
            code: 'return 7',
            timeoutMs: 1000,
          }),
        }),
        inspectInput(input) {
          assert.deepEqual(
            input.tools?.map((tool) => tool.name),
            [PTC_EXECUTE_CODE_TOOL_NAME, PTC_EXECUTE_CODE_WAIT_TOOL_NAME],
          );
        },
      },
      providerFinalAnswerRound('done'),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'done');
  assert.deepEqual(observedRunContext, {
    ...runContext,
    ownerKind: 'root_main',
  });
  assert.equal(observedCode, 'return 7');
  assert.deepEqual(observedCallbackToolNames, []);
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'tool_result',
      'final_answer_delta',
    ],
  );
});

void test('runAgentLoop exposes browser_navigate as an approval-gated model-visible PTC tool', async () => {
  const threadId = testThreadId(331);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-browser-navigate-tool-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-browser-navigate-tool',
    runContext,
  });
  const events: AgentEvent[] = [];
  let observedUrl = '';
  let observedRunContext:
    | Parameters<PtcBrowserNavigateRuntime['navigate']>[0]['runContext']
    | undefined;
  const ptcBrowserNavigate: PtcBrowserNavigateRuntime = {
    async navigate(args) {
      observedRunContext = args.runContext;
      observedUrl = args.request.url;
      return {
        ok: false,
        kind: 'ptc_lab_browser_user_url_navigation_error',
        reasonCode: 'ptc_lab_browser_url_admission_failed',
        message: 'PTC lab browser user URL navigation target admission failed',
        phase: 'request_admission',
        diagnostics: { admissionReasonCode: 'url_parse_failed' },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-browser-navigate-tool',
    runContext,
    prompt: 'navigate',
    runState,
    toolSurface: {
      directRegistryNames: [PTC_BROWSER_NAVIGATE_TOOL_NAME],
      allowedRegistryNames: [PTC_BROWSER_NAVIGATE_TOOL_NAME],
    },
    runtimeServices: {
      ...daemonContext,
      ptc: { ...daemonContext.ptc, browserNavigate: ptcBrowserNavigate },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-browser-navigate-tool',
      permissionMode: 'full_access',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerToolRound({
          toolName: PTC_BROWSER_NAVIGATE_TOOL_NAME,
          argumentsJson: JSON.stringify({
            url: 'https://example.com/',
            timeoutMs: 1000,
          }),
        }),
        inspectInput(input) {
          assert.deepEqual(
            input.tools?.map((tool) => tool.name),
            [PTC_BROWSER_NAVIGATE_TOOL_NAME],
          );
        },
      },
      providerFinalAnswerRound('done'),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'done');
  assert.deepEqual(observedRunContext, runContext);
  assert.equal(observedUrl, 'https://example.com/');
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'tool_result',
      'final_answer_delta',
    ],
  );
});

void test('runAgentLoop exposes browser_page_load_evidence as an approval-gated model-visible PTC tool', async () => {
  const threadId = testThreadId(332);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-browser-page-load-evidence-tool-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-browser-page-load-evidence-tool',
    runContext,
  });
  const events: AgentEvent[] = [];
  let observedUrl = '';
  let observedRunContext:
    | Parameters<
        PtcBrowserPageLoadEvidenceRuntime['collectEvidence']
      >[0]['runContext']
    | undefined;
  const ptcBrowserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime = {
    async collectEvidence(args) {
      observedRunContext = args.runContext;
      observedUrl = args.request.url;
      return {
        ok: false,
        kind: 'ptc_lab_browser_page_load_evidence_error',
        reasonCode: 'ptc_lab_browser_url_admission_failed',
        message: 'PTC lab browser page-load evidence target admission failed',
        phase: 'request_admission',
        diagnostics: { admissionReasonCode: 'url_parse_failed' },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-browser-page-load-evidence-tool',
    runContext,
    prompt: 'collect page-load evidence',
    runState,
    toolSurface: {
      directRegistryNames: [PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME],
      allowedRegistryNames: [PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME],
    },
    runtimeServices: {
      ...daemonContext,
      ptc: {
        ...daemonContext.ptc,
        browserPageLoadEvidence: ptcBrowserPageLoadEvidence,
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-browser-page-load-evidence-tool',
      permissionMode: 'full_access',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerToolRound({
          toolName: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
          argumentsJson: JSON.stringify({
            url: 'https://example.com/',
            timeoutMs: 1000,
          }),
        }),
        inspectInput(input) {
          assert.deepEqual(
            input.tools?.map((tool) => tool.name),
            [PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME],
          );
        },
      },
      providerFinalAnswerRound('done'),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'done');
  assert.deepEqual(observedRunContext, runContext);
  assert.equal(observedUrl, 'https://example.com/');
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'tool_result',
      'final_answer_delta',
    ],
  );
});

void test('runAgentLoop exposes browser_text_evidence as an approval-gated model-visible PTC tool', async () => {
  const threadId = testThreadId(333);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-browser-text-evidence-tool-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-browser-text-evidence-tool',
    runContext,
  });
  const events: AgentEvent[] = [];
  let observedUrl = '';
  let observedRunContext:
    | Parameters<
        PtcBrowserTextEvidenceRuntime['collectEvidence']
      >[0]['runContext']
    | undefined;
  const ptcBrowserTextEvidence: PtcBrowserTextEvidenceRuntime = {
    async collectEvidence(args) {
      observedRunContext = args.runContext;
      observedUrl = args.request.url;
      return {
        ok: false,
        kind: 'ptc_lab_browser_text_evidence_error',
        reasonCode: 'ptc_lab_browser_url_admission_failed',
        message: 'PTC lab browser text evidence target admission failed',
        phase: 'request_admission',
        diagnostics: { admissionReasonCode: 'url_parse_failed' },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await runAgentLoop({
    runId: 'run-loop-browser-text-evidence-tool',
    runContext,
    prompt: 'collect text evidence',
    runState,
    toolSurface: {
      directRegistryNames: [PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME],
      allowedRegistryNames: [PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME],
    },
    runtimeServices: {
      ...daemonContext,
      ptc: {
        ...daemonContext.ptc,
        browserTextEvidence: ptcBrowserTextEvidence,
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-browser-text-evidence-tool',
      permissionMode: 'full_access',
    }),
    callModelImpl: createScriptedProviderCallModel([
      {
        ...providerToolRound({
          toolName: PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
          argumentsJson: JSON.stringify({
            url: 'https://example.com/',
            timeoutMs: 1000,
          }),
        }),
        inspectInput(input) {
          assert.deepEqual(
            input.tools?.map((tool) => tool.name),
            [PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME],
          );
        },
      },
      providerFinalAnswerRound('done'),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'done');
  assert.deepEqual(observedRunContext, runContext);
  assert.equal(observedUrl, 'https://example.com/');
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    [
      'run_ack',
      'commentary_delta',
      'tool_call',
      'tool_result',
      'final_answer_delta',
    ],
  );
});

void test('runAgentLoop treats final prose JSON as final prose, not structured output', async () => {
  const threadId = testThreadId(303);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-json-prose-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const finalJson = JSON.stringify(
    structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
  );

  const result = await runAgentLoop({
    runId: 'run-loop-json-prose',
    runContext,
    prompt: 'return json-looking final prose',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-json-prose',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound(finalJson),
    ]),
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: finalJson,
  });
  assert.equal(daemonContext.sandboxAttempts.getAttempts().records.length, 0);
});

void test('runAgentLoop rejects ambiguous structured react bundle outputs', async () => {
  const threadId = testThreadId(304);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-ambiguous-structured-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-ambiguous-structured',
    runContext,
  });
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-ambiguous-structured',
    runContext,
    prompt: 'return two structured artifacts',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-ambiguous-structured',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerStructuredOutputRound([
        structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
        structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
      ]),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'failed');
  assert.equal(
    events.some(
      (event) =>
        event.type === 'error' &&
        /structured_output_ambiguous/.test(event.payload.message),
    ),
    true,
  );
  assert.equal(daemonContext.sandboxAttempts.getAttempts().records.length, 0);
});

void test('runAgentLoop rejects structured output mixed with tool calls', async () => {
  const threadId = testThreadId(305);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-tool-mix-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-loop-structured-tool-mix',
    runContext,
  });
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-structured-tool-mix',
    runContext,
    prompt: 'return a tool call and structured artifact',
    runState,
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-structured-tool-mix',
    }),
    callModelImpl: createScriptedProviderCallModel([
      composeProviderRounds(
        providerToolRound({
          toolName: 'read_file',
          commentaryText: '',
        }),
        providerStructuredOutputRound(
          structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
        ),
      ),
    ]),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'failed');
  assert.equal(
    events.some(
      (event) =>
        event.type === 'error' &&
        /structured_output_with_tool_calls/.test(event.payload.message),
    ),
    true,
  );
  assert.equal(daemonContext.sandboxAttempts.getAttempts().records.length, 0);
});

void test('runAgentLoop keeps pending background results out of stable instructions', async () => {
  const threadId = testThreadId(3);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-background-note-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
      computerSessionId: 'session-loop-background-note',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'background noted',
  });
  assert.doesNotMatch(seenSystemPrompt, /Background child updates:/);
  assert.doesNotMatch(seenSystemPrompt, /background child failed/);
  assert.equal(
    notifications.consumeThreadBackgroundResults(threadId).length,
    1,
  );
});

void test('runAgentLoop forwards an injected provider websocket session store', async () => {
  const threadId = testThreadId(4);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-ws-store-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
      provider: {
        ...daemonContext.provider,
        webSocketSessions: providerWebSocketSessions,
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-ws-store',
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

void test('runAgentLoop can use the runtime service default websocket session store', async () => {
  const threadId = testThreadId(5);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-daemon-context-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const daemonContext = createDaemonContext();
  let seenStore:
    | {
        acquireWebSocket: typeof daemonContext.provider.webSocketSessions.acquireWebSocket;
      }
    | undefined;
  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('context noted'),
      inspectInput(input) {
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
      computerSessionId: 'session-loop-daemon-context',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'context noted',
  });
  assert.equal(seenStore, daemonContext.provider.webSocketSessions);
});
