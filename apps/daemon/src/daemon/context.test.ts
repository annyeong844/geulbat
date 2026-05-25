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
import { createRunState } from './agent/runtime/run-state.js';
import { createDaemonContext } from './context.js';
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

void test('createDaemonContext rejects invalid subagent concurrency policy', () => {
  assert.throws(
    () =>
      createDaemonContext({
        subagentConcurrencyPolicy: {
          maxConcurrentChildren: 0,
        },
      }),
    /invalid subagent maxConcurrentChildren/,
  );
});

void test('resolveSubagentConcurrencyPolicyFromEnv returns undefined when env is absent', () => {
  assert.equal(resolveSubagentConcurrencyPolicyFromEnv({}), undefined);
});

void test('resolveSubagentConcurrencyPolicyFromEnv accepts trimmed capacity bounds', () => {
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: ' 1 ',
    }),
    { maxConcurrentChildren: 1 },
  );
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: '64',
    }),
    { maxConcurrentChildren: 64 },
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
    '65',
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

void test('createDaemonContext freezes provider request options from env', () => {
  const previousModel = process.env.GEULBAT_CODEX_MODEL;
  const previousReasoningEffort = process.env.GEULBAT_CODEX_REASONING_EFFORT;
  const previousTextVerbosity = process.env.GEULBAT_CODEX_TEXT_VERBOSITY;
  process.env.GEULBAT_CODEX_MODEL = 'gpt-startup-freeze';
  process.env.GEULBAT_CODEX_REASONING_EFFORT = 'high';
  process.env.GEULBAT_CODEX_TEXT_VERBOSITY = 'low';

  try {
    const daemonContext = createDaemonContext();
    process.env.GEULBAT_CODEX_MODEL = 'gpt-mutated-after-startup';
    process.env.GEULBAT_CODEX_REASONING_EFFORT = 'xhigh';
    process.env.GEULBAT_CODEX_TEXT_VERBOSITY = 'high';

    assert.deepEqual(daemonContext.providerRequestOptions, {
      model: 'gpt-startup-freeze',
      reasoning: { effort: 'high', summary: 'auto' },
      text: { verbosity: 'low' },
    });
  } finally {
    restoreEnv('GEULBAT_CODEX_MODEL', previousModel);
    restoreEnv('GEULBAT_CODEX_REASONING_EFFORT', previousReasoningEffort);
    restoreEnv('GEULBAT_CODEX_TEXT_VERBOSITY', previousTextVerbosity);
  }
});

void test('createDaemonContext rejects invalid subagent background capacity env', () => {
  const previous = process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  process.env[SUBAGENT_BACKGROUND_CAPACITY_ENV] = '65';
  try {
    assert.throws(
      () => createDaemonContext(),
      new RegExp(`invalid ${SUBAGENT_BACKGROUND_CAPACITY_ENV}`),
    );
  } finally {
    restoreEnv(SUBAGENT_BACKGROUND_CAPACITY_ENV, previous);
  }
});
