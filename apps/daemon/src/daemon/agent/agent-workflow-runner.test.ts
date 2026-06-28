import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertRunId, type RunId } from '@geulbat/protocol/ids';
import { AGENT_WAIT_APPROVAL_BLOCKED_REASON } from '@geulbat/protocol/run-events';

import type { HistoryItem } from '../llm/index.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { createDaemonContext } from '../context.js';
import { createSubagentRunLauncher } from './subagent-support.js';
import {
  createAgentWavePlanner,
  type AgentWaveWorkItem,
} from './agent-wave-planner.js';
import {
  admitAgentWorkflowSerialFloor,
  createAgentWorkflowRunner,
  runAgentWorkflowPhaseWithSubagents,
  runAgentWorkflowWithSubagents,
  type AgentWorkflowWaveAttemptKind,
} from './agent-workflow-runner.js';
import type {
  ResourceBudgetProvider,
  ResourceBudgetSnapshot,
} from './resource-budget-provider.js';
import { buildAgentToolExecutionContextBase } from './loop-tool-runtime.js';
import { buildToolCallExecutionRuntime } from './loop-tool-runtime.js';
import { createRunState } from './runtime/run-state.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

const workItems: readonly AgentWaveWorkItem[] = [
  {
    itemId: 'inspect-a',
    task: 'Inspect subsystem A',
    subagentType: 'explorer',
  },
  {
    itemId: 'inspect-b',
    task: 'Inspect subsystem B',
    subagentType: 'explorer',
  },
  {
    itemId: 'inspect-c',
    task: 'Inspect subsystem C',
    subagentType: 'explorer',
  },
];

function createSnapshot(snapshotId: string): ResourceBudgetSnapshot {
  return {
    snapshotId,
    capturedAt: '2026-06-19T00:00:00.000Z',
    cpu: {
      availableParallelism: {
        ok: true,
        value: 4,
        source: 'node_os_available_parallelism',
        confidence: 'trusted',
      },
    },
    memory: {
      hostTotalBytes: {
        ok: true,
        value: 16 * 1024 * 1024 * 1024,
        source: 'node_os_memory',
        confidence: 'advisory',
      },
      hostFreeBytes: {
        ok: true,
        value: 8 * 1024 * 1024 * 1024,
        source: 'node_os_memory',
        confidence: 'advisory',
      },
      daemonConstrainedMemoryBytes: {
        ok: false,
        source: 'node_process_constrained_memory',
        confidence: 'unavailable',
        reasonCode: 'unavailable',
        message: 'daemon constrained memory bytes unavailable',
      },
      daemonAvailableMemoryBytes: {
        ok: false,
        source: 'node_process_available_memory',
        confidence: 'unavailable',
        reasonCode: 'unavailable',
        message: 'daemon available memory bytes unavailable',
      },
      precedence: 'host_os_context_only',
    },
    subagents: {
      activeBackgroundChildren: {
        ok: true,
        value: 0,
        source: 'run_state_background_children',
        confidence: 'trusted',
      },
    },
  };
}

function createSnapshotProvider(): ResourceBudgetProvider {
  let captureCount = 0;
  return {
    captureSnapshot() {
      captureCount += 1;
      return createSnapshot(`resource-snapshot-${captureCount}`);
    },
  };
}

void test('AgentWorkflowRunner runs one phase as sequential visible waves', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });
  const launchedWaves: string[][] = [];

  const result = await runner.runPhase({
    phaseId: 'inspection',
    workItems,
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-at-a-time',
    },
    admitSerialFloor: () => ({
      kind: 'admitted',
      evidenceRef: 'admission:serial-floor',
    }),
    async launchWave({ selectedItems, waveIndex }) {
      launchedWaves.push(selectedItems.map((item) => item.itemId));
      return {
        ok: true,
        completedItemIds: selectedItems.map((item) => item.itemId),
        telemetryRefs: [`telemetry:inspection:${waveIndex}`],
        evidenceRefs: [`launch:inspection:${waveIndex}`],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(launchedWaves, [['inspect-a', 'inspect-b'], ['inspect-c']]);
  assert.deepEqual(result.completedItemIds, [
    'inspect-a',
    'inspect-b',
    'inspect-c',
  ]);
  assert.equal(result.waves.length, 2);
  assert.deepEqual(result.telemetry, {
    recordedWaveAttempts: 2,
    serialSafetyFloorAttempts: 0,
    widenedAttempts: 2,
    admissionDownshiftAttempts: 0,
  });
  assert.deepEqual(result.progress, {
    phaseId: 'inspection',
    status: 'completed',
    waveAttemptCount: 2,
    launchedItemCount: 3,
    completedItemCount: 3,
    waitingItemCount: 0,
    totalItemCount: 3,
    capacitySource: 'explicit_policy',
    capacityReasonCode: 'explicit_user_policy',
  });
  const firstWaveDecision = result.waves[0]?.decision;
  assert.equal(firstWaveDecision?.ok, true);
  assert.equal(
    firstWaveDecision.capacityReason.reasonCode,
    'explicit_user_policy',
  );
  const secondWaveDecision = result.waves[1]?.decision;
  assert.equal(secondWaveDecision?.ok, true);
  assert.deepEqual(secondWaveDecision.capacityReason.evidenceRefs, [
    'resource-snapshot-2',
    'user-policy:two-at-a-time',
    'telemetry:inspection:0',
  ]);
});

void test('AgentWorkflowRunner downshifts a rejected wider wave to the serial floor', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });
  const attempts: Array<{
    kind: AgentWorkflowWaveAttemptKind;
    selectedItemIds: string[];
  }> = [];

  const result = await runner.runPhase({
    phaseId: 'inspection',
    workItems: workItems.slice(0, 2),
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-at-a-time',
    },
    admitSerialFloor: () => ({
      kind: 'admitted',
      evidenceRef: 'admission:serial-floor',
    }),
    async launchWave({ selectedItems, attemptKind }) {
      attempts.push({
        kind: attemptKind,
        selectedItemIds: selectedItems.map((item) => item.itemId),
      });
      if (selectedItems.length > 1) {
        return {
          ok: false,
          reasonCode: 'admission_rejected',
          message: 'subagent admission rejected two children',
          evidenceRefs: ['admission:rejected:two'],
        };
      }
      return {
        ok: true,
        completedItemIds: selectedItems.map((item) => item.itemId),
        telemetryRefs: ['telemetry:downshift'],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [
    {
      kind: 'planned',
      selectedItemIds: ['inspect-a', 'inspect-b'],
    },
    {
      kind: 'admission_downshift',
      selectedItemIds: ['inspect-a'],
    },
    {
      kind: 'planned',
      selectedItemIds: ['inspect-b'],
    },
  ]);
  assert.equal(result.waves[1]?.attemptKind, 'admission_downshift');
  assert.deepEqual(result.telemetry, {
    recordedWaveAttempts: 3,
    serialSafetyFloorAttempts: 0,
    widenedAttempts: 2,
    admissionDownshiftAttempts: 1,
  });
  assert.deepEqual(result.progress, {
    phaseId: 'inspection',
    status: 'completed',
    waveAttemptCount: 3,
    launchedItemCount: 2,
    completedItemCount: 2,
    waitingItemCount: 0,
    totalItemCount: 2,
    capacitySource: 'explicit_policy',
    capacityReasonCode: 'explicit_user_policy',
  });
  const downshiftDecision = result.waves[1]?.decision;
  assert.equal(downshiftDecision?.ok, true);
  assert.equal(
    downshiftDecision.capacityReason.reasonCode,
    'admission_downshift',
  );
});

void test('AgentWorkflowRunner runs phases strictly after prior phase completion', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });
  const firstPhaseStarted = createDeferred<void>();
  const releaseFirstPhase = createDeferred<void>();
  const launchOrder: string[] = [];
  let inspectionCompleted = false;

  const running = runner.runWorkflow({
    phases: [
      {
        phaseId: 'inspection',
        workItems: workItems.slice(0, 1),
        admitSerialFloor: () => ({
          kind: 'admitted',
          evidenceRef: 'admission:inspection',
        }),
        async launchWave({ phaseId, selectedItems }) {
          launchOrder.push(phaseId);
          firstPhaseStarted.resolve();
          await releaseFirstPhase.promise;
          inspectionCompleted = true;
          return {
            ok: true,
            completedItemIds: selectedItems.map((item) => item.itemId),
            telemetryRefs: ['telemetry:inspection'],
          };
        },
      },
      {
        phaseId: 'adversarial_verification',
        workItems: [
          {
            itemId: 'verify-a',
            task: 'Verify subsystem A finding',
            subagentType: 'worker',
          },
        ],
        admitSerialFloor: () => ({
          kind: 'admitted',
          evidenceRef: 'admission:verification',
        }),
        async launchWave({ phaseId, selectedItems }) {
          assert.equal(inspectionCompleted, true);
          launchOrder.push(phaseId);
          return {
            ok: true,
            completedItemIds: selectedItems.map((item) => item.itemId),
            telemetryRefs: ['telemetry:verification'],
          };
        },
      },
    ],
  });

  await firstPhaseStarted.promise;
  assert.deepEqual(launchOrder, ['inspection']);
  releaseFirstPhase.resolve();

  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(result.completedPhaseIds, [
    'inspection',
    'adversarial_verification',
  ]);
  assert.deepEqual(launchOrder, ['inspection', 'adversarial_verification']);
  assert.equal(result.phaseResults.length, 2);
  assert.deepEqual(
    result.progress.map((progress) => ({
      phaseId: progress.phaseId,
      status: progress.status,
      completedItemCount: progress.completedItemCount,
      waitingItemCount: progress.waitingItemCount,
    })),
    [
      {
        phaseId: 'inspection',
        status: 'completed',
        completedItemCount: 1,
        waitingItemCount: 0,
      },
      {
        phaseId: 'adversarial_verification',
        status: 'completed',
        completedItemCount: 1,
        waitingItemCount: 0,
      },
    ],
  );
});

void test('AgentWorkflowRunner stops before the next phase when a phase fails', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });
  const launchOrder: string[] = [];

  const result = await runner.runWorkflow({
    phases: [
      {
        phaseId: 'inspection',
        workItems: workItems.slice(0, 1),
        admitSerialFloor: () => ({
          kind: 'admitted',
          evidenceRef: 'admission:inspection',
        }),
        async launchWave({ phaseId }) {
          launchOrder.push(phaseId);
          return {
            ok: true,
            completedItemIds: [],
            telemetryRefs: ['telemetry:inspection'],
          };
        },
      },
      {
        phaseId: 'adversarial_verification',
        workItems: workItems.slice(1, 2),
        admitSerialFloor: () => ({
          kind: 'admitted',
          evidenceRef: 'admission:verification',
        }),
        async launchWave({ phaseId, selectedItems }) {
          launchOrder.push(phaseId);
          return {
            ok: true,
            completedItemIds: selectedItems.map((item) => item.itemId),
            telemetryRefs: ['telemetry:verification'],
          };
        },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhaseId, 'inspection');
  assert.equal(result.reasonCode, 'wave_no_progress');
  assert.deepEqual(launchOrder, ['inspection']);
  assert.equal(result.phaseResults.length, 1);
  assert.deepEqual(
    result.progress.map((progress) => ({
      phaseId: progress.phaseId,
      status: progress.status,
      completedItemCount: progress.completedItemCount,
      waitingItemCount: progress.waitingItemCount,
      capacitySource: progress.capacitySource,
    })),
    [
      {
        phaseId: 'inspection',
        status: 'failed',
        completedItemCount: 0,
        waitingItemCount: 0,
        capacitySource: 'serial_safety_floor',
      },
      {
        phaseId: 'adversarial_verification',
        status: 'pending',
        completedItemCount: 0,
        waitingItemCount: 1,
        capacitySource: 'unknown',
      },
    ],
  );
});

void test('AgentWorkflowRunner fails visibly when the serial floor admission is unknown', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });

  const result = await runner.runPhase({
    phaseId: 'inspection',
    workItems,
    admitSerialFloor: () => ({
      kind: 'unknown',
      message: 'subagent admission state unavailable',
      evidenceRef: 'admission:unknown',
    }),
    async launchWave() {
      throw new Error('launchWave should not be called');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    phaseId: 'inspection',
    reasonCode: 'capacity_unknown',
    message: 'subagent admission state unavailable',
    evidenceRefs: ['admission:unknown'],
    waves: [],
    telemetry: {
      recordedWaveAttempts: 0,
      serialSafetyFloorAttempts: 0,
      widenedAttempts: 0,
      admissionDownshiftAttempts: 0,
    },
    progress: {
      phaseId: 'inspection',
      status: 'failed',
      waveAttemptCount: 0,
      launchedItemCount: 0,
      completedItemCount: 0,
      waitingItemCount: 3,
      totalItemCount: 3,
      capacitySource: 'unknown',
    },
  });
});

void test('AgentWorkflowRunner treats missing wave results as no progress', async () => {
  const runner = createAgentWorkflowRunner({
    agentWavePlanner: createAgentWavePlanner(),
    resourceBudgetProvider: createSnapshotProvider(),
  });

  const result = await runner.runPhase({
    phaseId: 'inspection',
    workItems: workItems.slice(0, 1),
    admitSerialFloor: () => ({
      kind: 'admitted',
      evidenceRef: 'admission:serial-floor',
    }),
    async launchWave() {
      return {
        ok: true,
        completedItemIds: [],
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'wave_no_progress');
  assert.equal(result.waves.length, 1);
  assert.deepEqual(result.telemetry, {
    recordedWaveAttempts: 1,
    serialSafetyFloorAttempts: 1,
    widenedAttempts: 0,
    admissionDownshiftAttempts: 0,
  });
  assert.deepEqual(result.progress, {
    phaseId: 'inspection',
    status: 'failed',
    waveAttemptCount: 1,
    launchedItemCount: 1,
    completedItemCount: 0,
    waitingItemCount: 0,
    totalItemCount: 1,
    capacitySource: 'serial_safety_floor',
    capacityReasonCode: 'serial_safety_floor',
  });
});

void test('admitAgentWorkflowSerialFloor uses subagent admission without consuming the launch slot', () => {
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  const runState = createRunState({
    runId: testRunId('workflow-serial-floor-parent'),
    runContext: makeRunWorkspaceContext({
      threadId: testThreadId(600),
      projectId: testProjectId('workflow-serial-floor'),
      workspaceRoot: '/tmp/workflow-serial-floor',
    }),
  });
  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext: runState,
    runId: runState.runId,
    runState,
    emit() {},
  });

  const admission = admitAgentWorkflowSerialFloor({
    phaseId: 'inspection',
    waveIndex: 0,
    runtime,
  });

  assert.equal(admission.kind, 'admitted');
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
  const launchAdmission =
    daemonContext.subagentAdmission.reserveSubagentLaunchSlots({
      runState,
      requestedChildren: 1,
    });
  assert.equal(launchAdmission.ok, true);
  if (launchAdmission.ok) {
    launchAdmission.reservation.release();
  }
});

void test('admitAgentWorkflowSerialFloor surfaces direct subagent admission rejection', () => {
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  const runState = createRunState({
    runId: testRunId('workflow-serial-floor-rejected-parent'),
    runContext: makeRunWorkspaceContext({
      threadId: testThreadId(601),
      projectId: testProjectId('workflow-serial-floor-rejected'),
      workspaceRoot: '/tmp/workflow-serial-floor-rejected',
    }),
  });
  runState.backgroundChildRunIds.add(testRunId('already-running-child'));
  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext: runState,
    runId: runState.runId,
    runState,
    emit() {},
  });

  const admission = admitAgentWorkflowSerialFloor({
    phaseId: 'inspection',
    waveIndex: 0,
    runtime,
  });

  assert.equal(admission.kind, 'rejected');
  assert.match(admission.message, /maximum 1 concurrent child agents allowed/u);
  assert.match(admission.evidenceRef, /too_many_child_runs/u);
});

void test('runAgentWorkflowPhaseWithSubagents launches a wave through agent_spawn and collects child results', async () => {
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-workflow-'));
  const threadId = testThreadId(610);
  const runId = testRunId('workflow-parent');
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('workflow'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const releaseChildren = createDeferred<void>();
  const allChildrenStarted = createDeferred<void>();
  const startedPrompts: string[] = [];
  const startedRunIds: RunId[] = [];

  daemonContext.subagentRuns = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      startedPrompts.push(input.prompt);
      startedRunIds.push(assertRunId(input.runId));
      if (startedPrompts.length === 2) {
        allChildrenStarted.resolve();
      }
      await releaseChildren.promise;
      return {
        ok: true,
        finalProse: `done:${input.prompt}`,
      };
    },
  });

  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext,
    runId,
    runState,
    emit(type) {
      events.push(type);
    },
  });
  const running = runAgentWorkflowPhaseWithSubagents({
    phaseId: 'inspection',
    workItems: workItems.slice(0, 2),
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-at-a-time',
    },
    history,
    runtime,
  });

  await allChildrenStarted.promise;
  assert.deepEqual([...startedPrompts].sort(), [
    'Inspect subsystem A',
    'Inspect subsystem B',
  ]);
  releaseChildren.resolve();

  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(result.completedItemIds, ['inspect-a', 'inspect-b']);
  assert.equal(result.waves.length, 1);
  assert.deepEqual(result.telemetry, {
    recordedWaveAttempts: 1,
    serialSafetyFloorAttempts: 0,
    widenedAttempts: 1,
    admissionDownshiftAttempts: 0,
  });
  assert.deepEqual(
    events.filter((event) => event === 'tool_call' || event === 'tool_result'),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
  assert.deepEqual(
    startedRunIds.map((childRunId) =>
      daemonContext.childRuns.getChildRun(childRunId),
    ),
    startedRunIds.map(() => undefined),
  );
});

void test('runAgentWorkflowPhaseWithSubagents reports blocked child waits as incomplete waves', async () => {
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-workflow-blocked-'),
  );
  const threadId = testThreadId(612);
  const runId = testRunId('workflow-blocked-parent');
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('workflow-blocked'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });
  const history: HistoryItem[] = [];
  const childStarted = createDeferred<void>();
  const releaseChild = createDeferred<void>();
  let childRunId: RunId | undefined;

  daemonContext.subagentRuns = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      childRunId = assertRunId(input.runId);
      childStarted.resolve();
      await releaseChild.promise;
      return {
        ok: true,
        finalProse: `done:${input.prompt}`,
      };
    },
  });

  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext,
    runId,
    runState,
    emit() {},
  });
  const running = runAgentWorkflowPhaseWithSubagents({
    phaseId: 'inspection',
    workItems: workItems.slice(0, 1),
    history,
    runtime,
  });

  try {
    await childStarted.promise;
    if (childRunId === undefined) {
      assert.fail('expected workflow child run id');
    }
    daemonContext.childRuns.markChildApprovalPending(childRunId);

    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'wave_blocked');
    assert.equal(
      result.message,
      `child run ${childRunId} is blocked: ${AGENT_WAIT_APPROVAL_BLOCKED_REASON}`,
    );
    assert.equal(result.progress.status, 'failed');
    assert.equal(result.progress.completedItemCount, 0);
    assert.equal(result.progress.waitingItemCount, 1);
    assert.equal(result.waves.length, 1);
    assert.equal(result.waves[0]?.launch.ok, false);
    if (result.waves[0]?.launch.ok === false) {
      assert.equal(result.waves[0].launch.reasonCode, 'wave_blocked');
      assert.deepEqual(result.waves[0].launch.evidenceRefs, [
        'inspection:0:0:inspect-a:agent_spawn_call',
        `child-run:${childRunId}`,
        `child-run:${childRunId}:blocked:${AGENT_WAIT_APPROVAL_BLOCKED_REASON}`,
      ]);
    }
  } finally {
    releaseChild.resolve();
  }
});

void test('runAgentWorkflowWithSubagents runs phases through agent_spawn and child waits', async () => {
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-workflow-multi-phase-'),
  );
  const threadId = testThreadId(615);
  const runId = testRunId('workflow-multi-phase-parent');
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('workflow-multi-phase'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const firstChildStarted = createDeferred<void>();
  const releaseFirstChild = createDeferred<void>();
  const startedPrompts: string[] = [];

  daemonContext.subagentRuns = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      startedPrompts.push(input.prompt);
      if (input.prompt === 'Inspect subsystem A') {
        firstChildStarted.resolve();
        await releaseFirstChild.promise;
      }
      return {
        ok: true,
        finalProse: `done:${input.prompt}`,
      };
    },
  });

  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext,
    runId,
    runState,
    emit(type) {
      events.push(type);
    },
  });
  const running = runAgentWorkflowWithSubagents({
    phases: [
      {
        phaseId: 'inspection',
        workItems: workItems.slice(0, 1),
      },
      {
        phaseId: 'adversarial_verification',
        workItems: [
          {
            itemId: 'verify-a',
            task: 'Verify subsystem A finding',
            subagentType: 'worker',
          },
        ],
      },
    ],
    history,
    runtime,
  });

  await firstChildStarted.promise;
  assert.deepEqual(startedPrompts, ['Inspect subsystem A']);
  releaseFirstChild.resolve();

  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(result.completedPhaseIds, [
    'inspection',
    'adversarial_verification',
  ]);
  assert.deepEqual(startedPrompts, [
    'Inspect subsystem A',
    'Verify subsystem A finding',
  ]);
  assert.deepEqual(
    events.filter((event) => event === 'tool_call' || event === 'tool_result'),
    ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
  );
  assert.deepEqual(
    result.progress.map((progress) => ({
      phaseId: progress.phaseId,
      status: progress.status,
      completedItemCount: progress.completedItemCount,
      waitingItemCount: progress.waitingItemCount,
      capacitySource: progress.capacitySource,
    })),
    [
      {
        phaseId: 'inspection',
        status: 'completed',
        completedItemCount: 1,
        waitingItemCount: 0,
        capacitySource: 'serial_safety_floor',
      },
      {
        phaseId: 'adversarial_verification',
        status: 'completed',
        completedItemCount: 1,
        waitingItemCount: 0,
        capacitySource: 'serial_safety_floor',
      },
    ],
  );
});

void test('AgentWorkflowRunner downshifts through the real subagent admission path', async () => {
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-workflow-downshift-'),
  );
  const threadId = testThreadId(620);
  const runId = testRunId('workflow-downshift-parent');
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('workflow-downshift'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId,
    runContext,
  });
  const history: HistoryItem[] = [];

  daemonContext.subagentRuns = createSubagentRunLauncher({
    runAgentLoop: async (input) => ({
      ok: true,
      finalProse: `done:${input.prompt}`,
    }),
  });

  const runtime = buildWorkflowToolRuntime({
    daemonContext,
    runContext,
    runId,
    runState,
    emit() {},
  });
  const result = await runAgentWorkflowPhaseWithSubagents({
    phaseId: 'inspection',
    workItems: workItems.slice(0, 2),
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-at-a-time',
    },
    history,
    runtime,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.completedItemIds, ['inspect-a', 'inspect-b']);
  assert.deepEqual(result.telemetry, {
    recordedWaveAttempts: 3,
    serialSafetyFloorAttempts: 0,
    widenedAttempts: 2,
    admissionDownshiftAttempts: 1,
  });
  assert.deepEqual(
    result.waves.map((wave) => ({
      attemptKind: wave.attemptKind,
      ok: wave.launch.ok,
      selectedItemIds: wave.selectedItemIds,
    })),
    [
      {
        attemptKind: 'planned',
        ok: false,
        selectedItemIds: ['inspect-a', 'inspect-b'],
      },
      {
        attemptKind: 'admission_downshift',
        ok: true,
        selectedItemIds: ['inspect-a'],
      },
      {
        attemptKind: 'planned',
        ok: true,
        selectedItemIds: ['inspect-b'],
      },
    ],
  );
});

function buildWorkflowToolRuntime(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  runContext: ReturnType<typeof makeRunWorkspaceContext>;
  runId: ReturnType<typeof testRunId>;
  runState: ReturnType<typeof createRunState>;
  emit: Parameters<typeof buildToolCallExecutionRuntime>[0]['emit'];
}) {
  const approvalContext = makeApprovalContext({
    sessionId: `${args.runId}-approval`,
  });
  return buildToolCallExecutionRuntime({
    approvalContext,
    emit: args.emit,
    toolRegistry: args.daemonContext.toolRegistry,
    approvalGate: args.daemonContext.approvalGate,
    approvalGrants: args.daemonContext.approvalGrants,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: args.runContext,
      runId: args.runId,
      approvalContext,
      emit: args.emit,
      currentFile: undefined,
      selection: undefined,
      signal: args.runState.abortController.signal,
      runState: args.runState,
      memoryIndex: undefined,
      agentSpawnRuntime: args.daemonContext,
    }),
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
