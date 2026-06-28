import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import { bootstrapDaemonContext } from '../bootstrap-daemon-context.js';
import {
  SUBAGENT_BACKGROUND_CAPACITY_ENV,
  resolveSubagentConcurrencyPolicyFromEnv,
} from './agent/subagent-concurrency.js';
import {
  REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV,
  resolveReactBundleStructuredOutputIngressPolicyFromEnv,
} from './agent/react-bundle-structured-output-ingress-policy.js';
import { createRunState } from './agent/runtime/run-state.js';
import { createDaemonContext } from './context.js';
import { resolveProviderRequestOptions } from './llm/provider/provider-options.js';
import {
  PTC_EXECUTE_CODE_CELL_ENABLED_ENV,
  PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV,
  PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV,
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv,
} from './ptc/runtime/execute-code/execute-code-runtime.js';
import { createRunInterjectBuffer } from './sessions/active-run-interject-buffer.js';
import { createRunWorkspaceContext } from './run-workspace-context.js';
import type { AnyTool } from './tools/types.js';
import { testProjectId } from '../test-support/project-id.js';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';

function createTestTool(name: string): AnyTool {
  return {
    name,
    description: 'test tool',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'none',
    mayMutateWorkspaceFiles: false,
    timeoutMs: 1_000,
    requiresApproval: false,
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: name };
    },
  };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function createSubagentCapacityRunState(runId = 'context-capacity-run') {
  return createRunState({
    runId,
    runContext: createRunWorkspaceContext({
      threadId: testThreadId(20),
      projectId: testProjectId(),
      workspaceRoot: '/tmp/workspace',
    }),
  });
}

void test('createDaemonContext isolates runtime singleton state per instance', async () => {
  const first = createDaemonContext();
  const second = createDaemonContext();
  const threadId = testThreadId(1);
  const runId = testRunId('context-a');

  assert.deepEqual(
    first.activeRuns.tryStartRun(threadId, {
      runId,
      threadId,
      projectId: testProjectId(),
      workspaceRoot: '/tmp/workspace',
      ownerThreadId: threadId,
      abortController: new AbortController(),
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.equal(second.activeRuns.getRunById(runId), undefined);

  const approvalContext = {
    runId,
    threadId,
    sessionId: 'session-context-a',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const wait = first.approvalGate.waitForApproval(
    'call-context-a',
    approvalContext.runId,
    threadId,
    approvalContext,
    AbortSignal.timeout(1_000),
  );
  assert.equal(
    first.approvalGate.resolveApproval(
      'call-context-a',
      approvalContext.runId,
      threadId,
      'approved',
      'run',
    ),
    'resolved',
  );
  assert.equal(await wait, 'approved');
  assert.equal(first.approvalGrants.hasApprovalGrant(approvalContext), true);
  assert.equal(second.approvalGrants.hasApprovalGrant(approvalContext), false);

  first.backgroundNotifications.enqueueThreadBackgroundResult(threadId, {
    parentRunId: testRunId('parent-context-a'),
    childRunId: testRunId('child-context-a'),
    deliveryId: 'delivery-context-a',
    subagentType: 'explorer',
    terminalState: 'completed',
    result: 'done',
    completedAt: '2026-03-30T00:00:01.000Z',
  });
  assert.equal(
    first.backgroundNotifications.consumeThreadBackgroundResults(threadId)
      .length,
    1,
  );
  assert.equal(
    second.backgroundNotifications.consumeThreadBackgroundResults(threadId)
      .length,
    0,
  );

  first.projectRegistry.replaceProjectRegistry([
    { projectId: testProjectId('workspace'), label: 'Workspace' },
    { projectId: testProjectId('alpha'), label: 'Alpha' },
  ]);
  assert.equal(first.projectRegistry.isKnownProjectId('alpha'), true);
  assert.equal(second.projectRegistry.isKnownProjectId('alpha'), false);

  first.toolRegistry.registerTool(createTestTool('context_tool_only'));
  assert.ok(first.toolRegistry.getTool('context_tool_only'));
  assert.equal(second.toolRegistry.getTool('context_tool_only'), undefined);

  first.providerAuthRuntime.setCachedProviderCredential({
    accessToken: 'context-access-token',
    refreshToken: 'context-refresh-token',
    accountId: 'context-account',
    expiresAt: 123,
  });
  first.providerAuthBootstrap.setPendingProviderAuthSession({
    authSessionId: 'context-auth-session',
    state: 'context-state',
    codeVerifier: 'context-verifier',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });
  assert.equal(
    first.providerAuthRuntime.getCachedProviderCredential()?.accessToken,
    'context-access-token',
  );
  assert.equal(second.providerAuthRuntime.getCachedProviderCredential(), null);
  assert.equal(
    first.providerAuthBootstrap.getPendingProviderAuthSession()?.authSessionId,
    'context-auth-session',
  );
  assert.equal(
    second.providerAuthBootstrap.getPendingProviderAuthSession(),
    null,
  );
  assert.notEqual(
    first.providerAuthCallbackServer,
    second.providerAuthCallbackServer,
  );
  assert.notEqual(first.memoryIndex, second.memoryIndex);
  assert.notEqual(
    first.providerWebSocketSessions,
    second.providerWebSocketSessions,
  );
  assert.notEqual(first.fileStateCache, second.fileStateCache);
  assert.notEqual(first.agentWorkflowRunner, second.agentWorkflowRunner);
  assert.notEqual(first.agentWavePlanner, second.agentWavePlanner);
  assert.notEqual(first.resourceBudgetProvider, second.resourceBudgetProvider);

  const firstRoot = await mkdtemp(join(tmpdir(), 'daemon-context-first-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'daemon-context-second-'));
  try {
    await bootstrapDaemonContext({
      projectStore: first.projectStore,
      repoRoot: firstRoot,
    });
    await bootstrapDaemonContext({
      projectStore: second.projectStore,
      repoRoot: secondRoot,
    });

    assert.equal(
      first.projectStore.getProjectRegistryFilePath(),
      join(firstRoot, '.geulbat', 'projects.json'),
    );
    assert.equal(
      second.projectStore.getProjectRegistryFilePath(),
      join(secondRoot, '.geulbat', 'projects.json'),
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

void test('createDaemonContext owns a PTC fixed probe runtime service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(
    typeof daemonContext.ptcFixedProbe.runFixedEpochProbe,
    'function',
  );
});

void test('createDaemonContext owns a resource budget observation service', () => {
  const daemonContext = createDaemonContext();

  const snapshot = daemonContext.resourceBudgetProvider.captureSnapshot({
    runState: createSubagentCapacityRunState('context-resource-budget'),
  });

  assert.equal(typeof snapshot.snapshotId, 'string');
  assert.equal(typeof snapshot.capturedAt, 'string');
  assert.equal(
    snapshot.subagents.activeBackgroundChildren.source,
    'run_state_background_children',
  );
  assert.equal(snapshot.subagents.activeBackgroundChildren.ok, true);
});

void test('createDaemonContext owns an agent wave planner service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(typeof daemonContext.agentWavePlanner.planNextWave, 'function');
});

void test('createDaemonContext owns an agent workflow runner service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(typeof daemonContext.agentWorkflowRunner.runPhase, 'function');
});

void test('createDaemonContext owns a PTC execute_code runtime service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(typeof daemonContext.ptcExecuteCode.executeCode, 'function');
  assert.equal(typeof daemonContext.ptcExecuteCode.closeAll, 'function');
});

void test('createDaemonContext owns a PTC browser navigation runtime service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(typeof daemonContext.ptcBrowserNavigate.navigate, 'function');
  assert.equal(typeof daemonContext.ptcBrowserNavigate.closeAll, 'function');
});

void test('createDaemonContext owns a PTC browser page-load evidence runtime service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(
    typeof daemonContext.ptcBrowserPageLoadEvidence.collectEvidence,
    'function',
  );
  assert.equal(
    typeof daemonContext.ptcBrowserPageLoadEvidence.closeAll,
    'function',
  );
});

void test('createDaemonContext owns a PTC browser text evidence runtime service', () => {
  const daemonContext = createDaemonContext();

  assert.equal(
    typeof daemonContext.ptcBrowserTextEvidence.collectEvidence,
    'function',
  );
  assert.equal(
    typeof daemonContext.ptcBrowserTextEvidence.closeAll,
    'function',
  );
});

void test('createDaemonContext owns an isolated sandbox attempt store', () => {
  const first = createDaemonContext();
  const second = createDaemonContext();

  const firstAttempt = first.sandboxAttempts.createAttempt({
    jobKind: 'test_sandbox_job',
    adapterKind: 'test_sandbox_adapter',
  });

  assert.equal(firstAttempt.attemptId, 'sandbox-attempt-1');
  assert.equal(first.sandboxAttempts.getAttempts().records.length, 1);
  assert.equal(second.sandboxAttempts.getAttempts().records.length, 0);
});

void test('createDaemonContext rejects invalid subagent concurrency policy', () => {
  const invalidMaxConcurrentChildren = [0, 1.5, 9007199254740992];

  for (const maxConcurrentChildren of invalidMaxConcurrentChildren) {
    assert.throws(
      () =>
        createDaemonContext({
          subagentConcurrencyPolicy: {
            maxConcurrentChildren,
          },
        }),
      /invalid subagent maxConcurrentChildren/,
    );
  }
});

void test('resolveSubagentConcurrencyPolicyFromEnv returns undefined when env is absent', () => {
  assert.equal(resolveSubagentConcurrencyPolicyFromEnv({}), undefined);
});

void test('resolveSubagentConcurrencyPolicyFromEnv accepts trimmed capacity values', () => {
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: ' 1 ',
    }),
    { maxConcurrentChildren: 1 },
  );
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: '128',
    }),
    { maxConcurrentChildren: 128 },
  );
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: 'unlimited',
    }),
    { maxConcurrentChildren: null },
  );
});

void test('resolveSubagentConcurrencyPolicyFromEnv rejects invalid capacity values', () => {
  const invalidValues = [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
  ];

  for (const value of invalidValues) {
    assert.throws(
      () =>
        resolveSubagentConcurrencyPolicyFromEnv({
          [SUBAGENT_BACKGROUND_CAPACITY_ENV]: value,
        }),
      new RegExp(`invalid ${SUBAGENT_BACKGROUND_CAPACITY_ENV}`),
    );
  }
});

void test('createDaemonContext uses subagent background capacity env when no explicit policy is supplied', () => {
  const previous = process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV] = '1';
  try {
    const daemonContext = createDaemonContext();
    const runState = createSubagentCapacityRunState('context-env-capacity');
    runState.backgroundChildRunIds.add(testRunId('already-running-child'));

    const result = daemonContext.subagentAdmission.reserveSubagentLaunchSlots({
      runState,
      requestedChildren: 1,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'too_many_child_runs');
      assert.equal(result.effectiveMax, 1);
    }
  } finally {
    restoreEnv(SUBAGENT_BACKGROUND_CAPACITY_ENV, previous);
  }
});

void test('createDaemonContext explicit subagent policy wins over env capacity', () => {
  const previous = process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV] = '1';
  try {
    const daemonContext = createDaemonContext({
      subagentConcurrencyPolicy: {
        maxConcurrentChildren: 2,
      },
    });
    const runState = createSubagentCapacityRunState(
      'context-explicit-capacity',
    );

    const result = daemonContext.subagentAdmission.reserveSubagentLaunchSlots({
      runState,
      requestedChildren: 2,
    });

    assert.equal(result.ok, true);
  } finally {
    restoreEnv(SUBAGENT_BACKGROUND_CAPACITY_ENV, previous);
  }
});

void test('createDaemonContext explicit undefined subagent policy suppresses env capacity', () => {
  const previous = process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV] = '1';
  try {
    const daemonContext = createDaemonContext({
      subagentConcurrencyPolicy: undefined,
    });
    const runState = createSubagentCapacityRunState(
      'context-explicit-undefined-capacity',
    );
    runState.backgroundChildRunIds.add(testRunId('child-1'));

    const result = daemonContext.subagentAdmission.reserveSubagentLaunchSlots({
      runState,
      requestedChildren: 1,
    });

    assert.equal(result.ok, true);
  } finally {
    restoreEnv(SUBAGENT_BACKGROUND_CAPACITY_ENV, previous);
  }
});

void test('createDaemonContext defaults to unlimited subagent background capacity', () => {
  const daemonContext = createDaemonContext();
  const runState = createSubagentCapacityRunState(
    'context-default-unlimited-capacity',
  );
  for (let index = 0; index < 12; index += 1) {
    runState.backgroundChildRunIds.add(testRunId(`child-${index}`));
  }

  const result = daemonContext.subagentAdmission.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 4,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    result.reservation.release();
  }
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv returns undefined when env is absent', () => {
  assert.equal(resolvePtcExecuteCodeCellRuntimeConfigFromEnv({}), undefined);
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv accepts explicit cell settings', () => {
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: ' true ',
      [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: ' 2500 ',
      [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: ' 600000 ',
    }),
    { enabled: true, initialYieldTimeMs: 2500, runningCellReapAfterMs: 600000 },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
    }),
    { enabled: false },
  );
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid enabled values', () => {
  for (const value of ['', ' ', 'TRUE', '1', 'yes', '0']) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: value,
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}`),
    );
  }
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid yield values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
          [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: value,
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV}`),
    );
  }
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid running reap values', () => {
  for (const value of [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
          [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
          [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: value,
        }),
      new RegExp(`invalid ${PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV}`),
    );
  }
});

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv requires enabled true for cell config', () => {
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
      }),
    new RegExp(
      `${PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
        [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '1000',
      }),
    new RegExp(
      `${PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV} is required when ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
});

void test('createDaemonContext freezes PTC execute_code cell config from env', async () => {
  const previousEnabled = process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV];
  const previousInitialYield =
    process.env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV];
  const previousRunningReap =
    process.env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV];
  process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV] = 'true';
  process.env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV] = '2500';
  process.env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV] = '600000';

  try {
    const daemonContext = createDaemonContext();
    process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV] = 'false';
    delete process.env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV];
    delete process.env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV];

    const wait = await daemonContext.ptcExecuteCode.waitForCell({
      runContext: { threadId: testThreadId(50) },
      request: { cellId: 'ptc_cell_context_env_freeze' },
    });

    assert.equal(wait.ok, true);
    if (wait.ok) {
      assert.equal(wait.value.status, 'missing');
    }
  } finally {
    restoreEnv(PTC_EXECUTE_CODE_CELL_ENABLED_ENV, previousEnabled);
    restoreEnv(
      PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV,
      previousInitialYield,
    );
    restoreEnv(PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV, previousRunningReap);
  }
});

void test('createDaemonContext explicit disabled PTC cell option suppresses env config', async () => {
  const previousEnabled = process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV];
  process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV] = 'true';

  try {
    const daemonContext = createDaemonContext({
      ptcExecuteCodeRuntimeOptions: { ptcCell: { enabled: false } },
    });

    assert.deepEqual(
      await daemonContext.ptcExecuteCode.waitForCell({
        runContext: { threadId: testThreadId(51) },
        request: { cellId: 'ptc_cell_context_env_suppressed' },
      }),
      {
        ok: false,
        reasonCode: 'ptc_execute_code_cell_wait_unavailable',
        message: 'PTC execute_code cell wait is not enabled',
      },
    );
  } finally {
    restoreEnv(PTC_EXECUTE_CODE_CELL_ENABLED_ENV, previousEnabled);
  }
});

void test('createDaemonContext freezes provider request options from env', () => {
  const previousModel = process.env.GEULBAT_CODEX_MODEL;
  const previousReasoningEffort = process.env.GEULBAT_CODEX_REASONING_EFFORT;
  const previousTextVerbosity = process.env.GEULBAT_CODEX_TEXT_VERBOSITY;
  const previousRetryRateLimited =
    process.env.GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES;
  process.env.GEULBAT_CODEX_MODEL = 'gpt-startup-freeze';
  process.env.GEULBAT_CODEX_REASONING_EFFORT = 'high';
  process.env.GEULBAT_CODEX_TEXT_VERBOSITY = 'low';
  process.env.GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES = '7';

  try {
    const daemonContext = createDaemonContext();
    process.env.GEULBAT_CODEX_MODEL = 'gpt-mutated-after-startup';
    process.env.GEULBAT_CODEX_REASONING_EFFORT = 'xhigh';
    process.env.GEULBAT_CODEX_TEXT_VERBOSITY = 'high';
    process.env.GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES = '0';

    assert.deepEqual(
      daemonContext.providerRequestOptions,
      resolveProviderRequestOptions({
        GEULBAT_CODEX_MODEL: 'gpt-startup-freeze',
        GEULBAT_CODEX_REASONING_EFFORT: 'high',
        GEULBAT_CODEX_TEXT_VERBOSITY: 'low',
        GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES: '7',
      }),
    );
  } finally {
    restoreEnv('GEULBAT_CODEX_MODEL', previousModel);
    restoreEnv('GEULBAT_CODEX_REASONING_EFFORT', previousReasoningEffort);
    restoreEnv('GEULBAT_CODEX_TEXT_VERBOSITY', previousTextVerbosity);
    restoreEnv(
      'GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES',
      previousRetryRateLimited,
    );
  }
});

void test('createDaemonContext freezes structured output ingress policy from env', () => {
  const previous =
    process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV];
  process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV] = '1234';

  try {
    const daemonContext = createDaemonContext();
    process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV] = '5678';

    assert.deepEqual(
      daemonContext.reactBundleStructuredOutputIngressPolicy,
      resolveReactBundleStructuredOutputIngressPolicyFromEnv({
        [REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV]: '1234',
      }),
    );
  } finally {
    restoreEnv(REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV, previous);
  }
});

void test('createDaemonContext explicit structured output ingress policy wins over env', () => {
  const previous =
    process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV];
  process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV] = '1234';

  try {
    const daemonContext = createDaemonContext({
      reactBundleStructuredOutputIngressPolicy: { timeoutMs: 4321 },
    });

    assert.deepEqual(daemonContext.reactBundleStructuredOutputIngressPolicy, {
      timeoutMs: 4321,
    });
  } finally {
    restoreEnv(REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV, previous);
  }
});

void test('createDaemonContext rejects invalid structured output ingress policy env', () => {
  const previous =
    process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV];
  process.env[REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV] = '0.5';

  try {
    assert.throws(
      () => createDaemonContext(),
      new RegExp(
        `invalid ${REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV}`,
      ),
    );
  } finally {
    restoreEnv(REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV, previous);
  }
});

void test('createDaemonContext rejects invalid subagent background capacity env', () => {
  const previous = process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV] = '1.5';
  try {
    assert.throws(
      () => createDaemonContext(),
      new RegExp(`invalid ${SUBAGENT_BACKGROUND_CAPACITY_ENV}`),
    );
  } finally {
    restoreEnv(SUBAGENT_BACKGROUND_CAPACITY_ENV, previous);
  }
});
