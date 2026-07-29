import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';
import { runAgentLoop } from './run-agent-loop.js';
import { createAgentLoopPromptPort } from './loop-prompt.js';
import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import type { AgentLoopObserverSnapshot } from './observer/agent-loop-observer.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { withoutProviderStatus } from '../../test-support/agent-events.js';
import { registerOnce } from '../../test-support/loop-tool-execution-test-support.js';
import { makePathArgumentTestTool } from '../../test-support/run-agent-loop.js';

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

void test('runAgentLoop fails closed when the provider calls a registered tool outside the admitted provider surface', async () => {
  const threadId = testThreadId(1221);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-unadmitted-provider-tool-'),
  );
  const events: AgentEvent[] = [];
  let executions = 0;
  const toolName = 'registered_but_unadmitted_tool';
  registerOnce(
    daemonContext,
    makePathArgumentTestTool({
      name: toolName,
      description:
        'must remain unreachable outside the admitted direct surface',
      sideEffectLevel: 'none',
      requiresApproval: false,
      async executeParsed() {
        executions += 1;
        return { ok: true, output: 'must not execute' };
      },
    }),
  );

  const result = await runAgentLoop({
    runId: 'run-loop-unadmitted-provider-tool',
    runContext: makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    prompt: 'do not execute tools outside this run surface',
    toolCapabilityPolicy: createToolCapabilityPolicy({
      directRegistryNames: [],
      allowedRegistryNames: [],
      callbackRegistryNames: [],
      writeCallbackEnabled: false,
    }),
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-unadmitted-provider-tool',
      permissionMode: 'full_access',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerToolRound({ toolName }),
      providerFinalAnswerRound('provider tool call was not rejected'),
    ]),
    onEvent(event) {
      events.push(event);
    },
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(executions, 0);
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['run_ack', 'commentary_delta', 'error'],
  );
  const terminalEvent = events.at(-1);
  assert.equal(terminalEvent?.type, 'error');
  if (terminalEvent?.type !== 'error') {
    throw new Error('expected terminal error event');
  }
  assert.match(
    terminalEvent.payload.message,
    /provider requested a tool outside the admitted provider surface/u,
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
    directRegistryNames: ['list_files', 'tool_search'],
    allowedRegistryNames: ['list_files', 'read_file', 'tool_search'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const toolLibraryProjectionIdentity = {
    sdkVersion: 'sdk-policy-test',
    sdkProjectionHash:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: toolCapabilityPolicy.toolCapabilityPolicyId,
  } as const;
  const definitionAdmissions: Array<readonly string[] | undefined> = [];
  const projectionPolicies: unknown[] = [];
  const expectedProjectionIdentities: unknown[] = [];
  const executionPolicies: unknown[] = [];
  const executionAllowedRegistryNames: Array<readonly string[] | undefined> =
    [];
  const promptDirectRegistryNames: Array<readonly string[] | undefined> = [];
  const modelDirectToolNames: string[][] = [];
  const modelDeferredToolNames: Array<string[] | undefined> = [];
  const snapshots: AgentLoopObserverSnapshot[] = [];
  let modelRound = 0;
  const promptPort = createAgentLoopPromptPort();

  const result = await runAgentLoop({
    runId: 'run-loop-tool-capability-policy',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'use the bounded tool policy',
    providerModel: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
    },
    toolCapabilityPolicy,
    toolLibraryProjectionIdentity,
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
        expectedProjectionIdentities.push(args.expectedIdentity);
        return {
          ok: true,
          identity: toolLibraryProjectionIdentity,
        };
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        modelDirectToolNames.push(args.toolDefs.map((tool) => tool.name));
        modelDeferredToolNames.push(
          args.providerDeferredToolDefs?.map((tool) => tool.name),
        );
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc-policy-read-file',
                  callId: 'call-policy-read-file',
                  name: 'read_file',
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
  assert.deepEqual(definitionAdmissions, [['list_files'], ['read_file']]);
  assert.deepEqual(promptDirectRegistryNames, [['list_files']]);
  assert.deepEqual(modelDirectToolNames, [['list_files'], ['list_files']]);
  assert.deepEqual(modelDeferredToolNames, [['read_file'], ['read_file']]);
  assert.deepEqual(projectionPolicies, [toolCapabilityPolicy]);
  assert.deepEqual(expectedProjectionIdentities, [
    toolLibraryProjectionIdentity,
  ]);
  assert.deepEqual(executionPolicies, [toolCapabilityPolicy]);
  assert.deepEqual(executionAllowedRegistryNames, [
    ['list_files', 'read_file', 'tool_search'],
  ]);
  assert.deepEqual(snapshots[0]?.toolSurface.admission, {
    kind: 'restricted',
    directRegistryNames: ['list_files', 'tool_search'],
    allowedRegistryNames: ['list_files', 'read_file', 'tool_search'],
  });
  assert.equal(
    snapshots[0]?.toolSurface.toolLibraryProjection?.policyId,
    toolCapabilityPolicy.toolCapabilityPolicyId,
  );
});

void test('runAgentLoop applies each model tool-discovery policy to the provider surface', async () => {
  const cases = [
    {
      providerId: 'qwen_token_plan' as const,
      model: 'qwen3.8-max-preview' as const,
      expectedDirectToolNames: [
        'external_provider_additional',
        'external_provider_fallback',
        'list_files',
      ],
      expectedDeferredToolNames: undefined,
    },
    {
      providerId: 'grok_oauth' as const,
      model: 'grok-4.5' as const,
      expectedDirectToolNames: [
        'external_provider_additional',
        'external_provider_fallback',
        'list_files',
      ],
      expectedDeferredToolNames: undefined,
    },
    {
      providerId: 'openai_codex_direct' as const,
      model: 'gpt-5.6-sol' as const,
      expectedDirectToolNames: ['list_files'],
      expectedDeferredToolNames: [
        'external_provider_additional',
        'external_provider_fallback',
      ],
    },
    {
      providerId: 'openai_codex_direct' as const,
      model: 'gpt-5.6-terra' as const,
      expectedDirectToolNames: ['list_files'],
      expectedDeferredToolNames: [
        'external_provider_additional',
        'external_provider_fallback',
      ],
    },
    {
      providerId: 'openai_codex_direct' as const,
      model: 'gpt-5.6-luna' as const,
      expectedDirectToolNames: ['list_files'],
      expectedDeferredToolNames: [
        'external_provider_additional',
        'external_provider_fallback',
      ],
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const threadId = testThreadId(1223 + index);
    const daemonContext = createDaemonContext();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), `geulbat-loop-provider-fallback-${index}-`),
    );
    let executions = 0;
    let modelRound = 0;
    registerOnce(daemonContext, {
      ...makePathArgumentTestTool({
        name: 'external_provider_fallback',
        description:
          'An allowlisted external tool that falls back to direct exposure.',
        sideEffectLevel: 'none',
        requiresApproval: false,
        async executeParsed() {
          executions += 1;
          return { ok: true, output: 'external fallback executed' };
        },
      }),
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        effectClass: 'readOnly',
      },
    });
    registerOnce(daemonContext, {
      ...makePathArgumentTestTool({
        name: 'external_provider_additional',
        description:
          'A second allowlisted external tool with no tool-specific fallback metadata.',
        sideEffectLevel: 'none',
        requiresApproval: false,
        async executeParsed() {
          throw new Error('the additional external tool must not execute');
        },
      }),
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        effectClass: 'readOnly',
      },
    });

    const result = await runAgentLoop({
      runId: `run-loop-provider-fallback-${index}`,
      runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
      prompt: 'execute the provider fallback tool',
      providerModel: {
        providerId: scenario.providerId,
        model: scenario.model,
      },
      toolCapabilityPolicy: createToolCapabilityPolicy({
        directRegistryNames: ['list_files', 'tool_search'],
        allowedRegistryNames: [
          'external_provider_additional',
          'external_provider_fallback',
          'list_files',
          'tool_search',
        ],
        callbackRegistryNames: [],
        writeCallbackEnabled: false,
      }),
      runtimeServices: daemonContext,
      approvalContext: makeApprovalContext({
        computerSessionId: `session-loop-provider-fallback-${index}`,
      }),
      modelRoundPort: {
        async runModelRound(args) {
          assert.deepEqual(
            args.toolDefs.map((tool) => tool.name),
            scenario.expectedDirectToolNames,
          );
          assert.deepEqual(
            args.providerDeferredToolDefs?.map((tool) => tool.name),
            scenario.expectedDeferredToolNames,
          );
          modelRound += 1;
          if (modelRound === 1) {
            return {
              ok: true,
              value: {
                assistantText: '',
                terminalResult: { ok: true, finalProse: '' },
                functionCalls: [
                  {
                    id: `fc-provider-fallback-${index}`,
                    callId: `call-provider-fallback-${index}`,
                    name: 'external_provider_fallback',
                    arguments: '{"path":"fixture"}',
                  },
                ],
              },
            };
          }
          return {
            ok: true,
            value: {
              assistantText: 'provider fallback complete',
              terminalResult: {
                ok: true,
                finalProse: 'provider fallback complete',
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
      finalProse: 'provider fallback complete',
    });
    assert.equal(executions, 1);
  }
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
    makePathArgumentTestTool({
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
            makePathArgumentTestTool({
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
