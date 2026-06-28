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
import { pushPendingInterject } from '../sessions/active-run-interject-buffer.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { createResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
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
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID,
} from './ptc-fixed-probe-structured-output-caller.js';
import { MID_RUN_STEER_ENABLED_ENV } from './mid-run-steer-flag.js';

function registerOnce(
  daemonContext: ReturnType<typeof createDaemonContext>,
  tool: AnyTool,
): void {
  daemonContext.toolRegistry.registerTool(tool);
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
    mayMutateWorkspaceFiles: false,
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

void test('runAgentLoop applies pending interject before the next steer-aware model round', async () => {
  const previousFlag = process.env[MID_RUN_STEER_ENABLED_ENV];
  process.env[MID_RUN_STEER_ENABLED_ENV] = '1';
  try {
    const threadId = testThreadId(1201);
    const daemonContext = createDaemonContext();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-loop-interject-run-'),
    );
    const events: AgentEvent[] = [];
    const runContext = makeRunWorkspaceContext({
      threadId,
      projectId: testProjectId('project'),
      workspaceRoot,
    });
    const runState = createRunState({
      runId: 'run-loop-interject',
      runContext,
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
          assert.equal(
            input.history.some(
              (item) =>
                item.kind === 'assistant' &&
                item.phase === 'final_answer' &&
                item.text === 'first answer',
            ),
            true,
          );
        },
      },
    ]);

    const result = await runAgentLoop({
      runId: 'run-loop-interject',
      runContext,
      prompt: 'please answer once',
      runState,
      allowedToolNames: [],
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext({
        sessionId: 'session-loop-interject',
      }),
      callModelImpl,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'final_answer_delta' && !injected) {
          injected = true;
          pushPendingInterject(runState.interject, 'please revise');
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
      events.map((event) => event.type),
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
  } finally {
    if (previousFlag === undefined) {
      delete process.env[MID_RUN_STEER_ENABLED_ENV];
    } else {
      process.env[MID_RUN_STEER_ENABLED_ENV] = previousFlag;
    }
  }
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [toolName],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-while-rounds',
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

void test('runAgentLoop routes structured react bundle output through typed ingress', async () => {
  const threadId = testThreadId(301);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-react-bundle-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-structured-react-bundle',
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
    events.map((event) => event.type),
    ['run_ack'],
  );
});

void test('runAgentLoop records structured output before applying a pending steer', async () => {
  const previousFlag = process.env[MID_RUN_STEER_ENABLED_ENV];
  process.env[MID_RUN_STEER_ENABLED_ENV] = '1';
  try {
    const threadId = testThreadId(1202);
    const daemonContext = createDaemonContext();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-loop-structured-interject-'),
    );
    const runContext = makeRunWorkspaceContext({
      threadId,
      projectId: testProjectId('project'),
      workspaceRoot,
    });
    const runState = createRunState({
      runId: 'run-loop-structured-interject',
      runContext,
    });
    const events: AgentEvent[] = [];
    let injected = false;

    const result = await runAgentLoop({
      runId: 'run-loop-structured-interject',
      runContext,
      prompt: 'create a structured react bundle artifact',
      runState,
      allowedToolNames: [],
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext({
        sessionId: 'session-loop-structured-interject',
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
              pushPendingInterject(
                runState.interject,
                'please revise artifact',
              );
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
                  item.kind === 'user' &&
                  item.text === 'please revise artifact',
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
      events.map((event) => event.type),
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
  } finally {
    if (previousFlag === undefined) {
      delete process.env[MID_RUN_STEER_ENABLED_ENV];
    } else {
      process.env[MID_RUN_STEER_ENABLED_ENV] = previousFlag;
    }
  }
});

void test('runAgentLoop routes structured PTC fixed probe output through daemon runtime', async () => {
  const threadId = testThreadId(302);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-structured-ptc-fixed-probe-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [],
    runtimeServices: { ...daemonContext, ptcFixedProbe },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-structured-ptc-fixed-probe',
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
    events.map((event) => event.type),
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [
      PTC_EXECUTE_CODE_TOOL_NAME,
      PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
    ],
    runtimeServices: { ...daemonContext, ptcExecuteCode },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-execute-code-tool',
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
  assert.deepEqual(observedRunContext, runContext);
  assert.equal(observedCode, 'return 7');
  assert.deepEqual(observedCallbackToolNames, []);
  assert.equal(runState.status, 'completed');
  assert.deepEqual(
    events.map((event) => event.type),
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [PTC_BROWSER_NAVIGATE_TOOL_NAME],
    runtimeServices: { ...daemonContext, ptcBrowserNavigate },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-browser-navigate-tool',
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
    events.map((event) => event.type),
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME],
    runtimeServices: { ...daemonContext, ptcBrowserPageLoadEvidence },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-browser-page-load-evidence-tool',
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
    events.map((event) => event.type),
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME],
    runtimeServices: { ...daemonContext, ptcBrowserTextEvidence },
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-browser-text-evidence-tool',
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
    events.map((event) => event.type),
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const finalJson = JSON.stringify(
    structuredReactBundleOutput(STRUCTURED_NO_DEPENDENCY_REQUEST),
  );

  const result = await runAgentLoop({
    runId: 'run-loop-json-prose',
    runContext,
    prompt: 'return json-looking final prose',
    allowedToolNames: [],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-json-prose',
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-ambiguous-structured',
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
    allowedToolNames: [],
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: 'session-loop-structured-tool-mix',
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
