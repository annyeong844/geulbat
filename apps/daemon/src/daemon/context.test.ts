import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import {
  SUBAGENT_BACKGROUND_CAPACITY_ENV,
  resolveSubagentConcurrencyPolicyFromEnv,
} from './agent/subagent-concurrency.js';
import {
  REACT_BUNDLE_STRUCTURED_OUTPUT_INGRESS_TIMEOUT_MS_ENV,
  resolveReactBundleStructuredOutputIngressPolicyFromEnv,
} from './agent/react-bundle-structured-output-ingress-policy.js';
import { createRunState } from './agent/runtime/run-state.js';
import { createResourceBudgetProvider } from './agent/resource-budget-provider.js';
import {
  createDaemonContext,
  projectPtcExecuteCodePlacementResourceBudget,
} from './context.js';
import { resolveProviderRequestOptions } from './llm/provider/provider-options.js';
import {
  PTC_EXECUTE_CODE_CELL_ENABLED_ENV,
  PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV,
  PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV,
  PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV,
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv,
} from './ptc/runtime/execute-code/execute-code-runtime.js';
import { PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS } from './ptc/runtime/execute-code/execute-code-cell-registry.js';
import { createRunInterjectBuffer } from './sessions/active-run-interject-buffer.js';
import { createRunContext } from './run-context.js';
import type { AnyTool } from './tools/types.js';
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
    mayMutateComputerFiles: false,
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
    runContext: createRunContext({
      threadId: testThreadId(20),
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
    }),
  });
}

void test('PTC resource projection uses host memory when Node reports an invalid unconstrained sentinel', () => {
  const snapshot = createResourceBudgetProvider({
    reader: {
      createSnapshotId: () => 'resource-snapshot-wsl-sentinel',
      now: () => '2026-07-14T00:00:00.000Z',
      readAvailableParallelism: () => 12,
      readHostTotalMemoryBytes: () => 8_000,
      readHostFreeMemoryBytes: () => 4_000,
      readDaemonConstrainedMemoryBytes: () => Number.MAX_SAFE_INTEGER + 1,
      readDaemonAvailableMemoryBytes: () => 4_000,
    },
  }).captureSnapshot();

  assert.equal(snapshot.memory.precedence, 'host_os_context_only');
  assert.deepEqual(
    projectPtcExecuteCodePlacementResourceBudget(snapshot)
      .constrainedMemoryBytes,
    { ok: true, value: 8_000 },
  );
});

void test('createDaemonContext exposes one consistent computer file authority root', () => {
  const daemonContext = createDaemonContext();

  assert.equal(
    daemonContext.computerFileRoot,
    daemonContext.computerFileScope?.root,
  );
});

void test('createDaemonContext isolates runtime singleton state per instance', async () => {
  const first = createDaemonContext();
  const second = createDaemonContext();
  const threadId = testThreadId(1);
  const runId = testRunId('context-a');

  assert.deepEqual(
    first.activeRuns.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
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
    providerId: 'openai_codex_direct',
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
  assert.notEqual(first.pluginSkills, first.plugins);
  assert.notEqual(second.pluginSkills, second.plugins);
  assert.notEqual(first.pluginSkills, second.pluginSkills);
});

void test('createDaemonContext installs a default tool library projection port', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-context-tool-library-'),
  );
  try {
    const daemonContext = createDaemonContext();
    assert.notEqual(daemonContext.toolLibraryProjection, undefined);

    const result = await daemonContext.toolLibraryProjection.resolveProjection({
      stateRoot: stateRoot,
      threadId: testThreadId(101),
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected default projection port to resolve');
    }
    assert.equal(result.projection.sdkVersion, 'geulbat-tool-library-sdk-v1');
    assert.equal(
      result.projection.sourceRegistryVersion,
      'daemon-builtin-tool-registry-v1',
    );
    assert.equal(
      result.projection.runtimeCompatibilityRange,
      'ptc_execute_code_sdk_v1',
    );
    assert.equal(
      result.projection.modelFacingCatalogRef,
      'geulbat-sdk://catalog',
    );
    assert.equal(result.projection.importSpecifier, 'geulbat-sdk');
    assert.equal(result.projection.policyId, 'ptc_sdk_reachable_read_tools_v1');
    assert.deepEqual(result.projection.allowedRegistryNames, [
      'fetch_url',
      'list_files',
      'read_file',
      'search_files',
      'search_memory_index',
    ]);
    assert.deepEqual(
      result.pin.allowedRegistryNames,
      result.projection.allowedRegistryNames,
    );
    assert.match(result.pin.projectionDirectory, /^sha256-[0-9a-f]{64}$/u);
    assert.equal(result.mount.importSpecifier, 'geulbat-sdk');
    assert.equal(
      result.mount.modelFacingCatalogRef,
      result.projection.modelFacingCatalogRef,
    );
    assert.equal(
      result.mount.sdkProjectionHash,
      result.projection.sdkProjectionHash,
    );
    assert.equal(result.mount.projectionRootPath, result.projection.rootPath);
    assert.match(
      result.projection.rootPath,
      /\.geulbat[\\/]+tool-library[\\/]+projections[\\/]+thread-[0-9a-f]{16}[\\/]+sha256-[0-9a-f]{64}$/u,
    );
    assert.equal(result.projection.rootPath.includes(testThreadId(101)), false);
    assert.equal(JSON.stringify(result.projection).includes(stateRoot), true);
    assert.equal(
      JSON.stringify({
        sdkVersion: result.projection.sdkVersion,
        sdkProjectionHash: result.projection.sdkProjectionHash,
        policyId: result.projection.policyId,
      }).includes(stateRoot),
      false,
    );
    assert.deepEqual(
      result.projection.tools.map((tool) => tool.wrapperModule),
      [
        'tools/fetch-url.js',
        'files/listFiles.js',
        'files/readFile.js',
        'files/searchFiles.js',
        'tools/search-memory-index.js',
      ],
    );
    assert.deepEqual(result.writtenFiles, [
      ...result.projection.files.map((file) => file.path),
    ]);
    assert.equal(
      await readFile(join(result.projection.rootPath, 'index.d.ts'), 'utf8'),
      result.projection.files.find((file) => file.path === 'index.d.ts')
        ?.content,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
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
    {
      enabled: true,
      initialYieldTimeMs: 2500,
      runningCellReapAfterMs: 600000,
      terminalResultMemoryRetentionMs:
        PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS,
    },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
      [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'true',
      [PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV]: '2500',
      [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
      [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '45000',
    }),
    {
      enabled: true,
      initialYieldTimeMs: 2500,
      runningCellReapAfterMs: 600000,
      terminalResultMemoryRetentionMs: 45000,
    },
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

void test('resolvePtcExecuteCodeCellRuntimeConfigFromEnv rejects invalid terminal memory retention values', () => {
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
          [PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV]: '600000',
          [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: value,
        }),
      new RegExp(
        `invalid ${PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV}`,
      ),
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
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '300000',
      }),
    new RegExp(
      `PTC execute_code cell settings require ${PTC_EXECUTE_CODE_CELL_ENABLED_ENV}=true`,
    ),
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeCellRuntimeConfigFromEnv({
        [PTC_EXECUTE_CODE_CELL_ENABLED_ENV]: 'false',
        [PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV]: '300000',
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
  const previousTerminalMemoryRetention =
    process.env[PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV];
  process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV] = 'true';
  process.env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV] = '2500';
  process.env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV] = '600000';
  process.env[PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV] = '45000';

  try {
    const daemonContext = createDaemonContext();
    process.env[PTC_EXECUTE_CODE_CELL_ENABLED_ENV] = 'false';
    delete process.env[PTC_EXECUTE_CODE_CELL_INITIAL_YIELD_MS_ENV];
    delete process.env[PTC_EXECUTE_CODE_CELL_RUNNING_REAP_MS_ENV];
    delete process.env[PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV];

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
    restoreEnv(
      PTC_EXECUTE_CODE_CELL_TERMINAL_MEMORY_RETENTION_MS_ENV,
      previousTerminalMemoryRetention,
    );
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
