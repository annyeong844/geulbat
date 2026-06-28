import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentWavePlanner,
  materializeAgentWaveSubagentFunctionCalls,
  type AgentWavePlanningInput,
  type AgentWaveSerialFloorAdmission,
  type AgentWaveWorkItem,
} from './agent-wave-planner.js';
import type { ResourceBudgetSnapshot } from './resource-budget-provider.js';

const snapshot: ResourceBudgetSnapshot = {
  snapshotId: 'resource-snapshot-1',
  capturedAt: '2026-06-18T00:00:00.000Z',
  cpu: {
    availableParallelism: {
      ok: true,
      value: 8,
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

const items: readonly AgentWaveWorkItem[] = [
  {
    itemId: 'item-a',
    task: 'Inspect subsystem A',
    subagentType: 'explorer',
  },
  {
    itemId: 'item-b',
    task: 'Inspect subsystem B',
    subagentType: 'explorer',
  },
  {
    itemId: 'item-c',
    task: 'Verify finding C',
    subagentType: 'worker',
  },
  {
    itemId: 'item-d',
    task: 'Verify finding D',
    subagentType: 'worker',
  },
];

const admittedSerialFloor: AgentWaveSerialFloorAdmission = {
  kind: 'admitted',
  evidenceRef: 'admission:serial-floor',
};

function plan(
  overrides: Partial<AgentWavePlanningInput> = {},
): ReturnType<ReturnType<typeof createAgentWavePlanner>['planNextWave']> {
  const planner = createAgentWavePlanner();
  return planner.planNextWave({
    phaseId: 'inspect',
    waveIndex: 0,
    remainingItems: items,
    resourceSnapshot: snapshot,
    serialFloorAdmission: admittedSerialFloor,
    ...overrides,
  });
}

void test('AgentWavePlanner proposes explicit user policy for the launch owner', () => {
  const decision = plan({
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 3,
      policyRef: 'user-policy:three-explorers',
    },
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.proposedItemIds, ['item-a', 'item-b', 'item-c']);
  assert.equal(decision.requestedItemCount, 3);
  assert.equal(decision.capacityReason.reasonCode, 'explicit_user_policy');
  assert.deepEqual(decision.capacityReason.evidenceRefs, [
    'resource-snapshot-1',
    'user-policy:three-explorers',
  ]);
});

void test('AgentWavePlanner leaves explicit policy admission to the launch owner', () => {
  const decision = plan({
    explicitPolicy: {
      source: 'runtime',
      requestedItemCount: 4,
      policyRef: 'runtime-policy:four',
    },
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.proposedItemIds, [
    'item-a',
    'item-b',
    'item-c',
    'item-d',
  ]);
  assert.equal(decision.requestedItemCount, 4);
  assert.equal(decision.capacityReason.reasonCode, 'explicit_runtime_policy');
  assert.deepEqual(decision.capacityReason.evidenceRefs, [
    'resource-snapshot-1',
    'runtime-policy:four',
  ]);
});

void test('AgentWavePlanner uses the serial safety floor when no wider numeric source exists', () => {
  const decision = plan();

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.proposedItemIds, ['item-a']);
  assert.equal(decision.requestedItemCount, 1);
  assert.equal(decision.capacityReason.reasonCode, 'serial_safety_floor');
  assert.deepEqual(decision.capacityReason.evidenceRefs, [
    'resource-snapshot-1',
    'admission:serial-floor',
  ]);
});

void test('AgentWavePlanner marks serial fallback after admission rejection as admission_downshift', () => {
  const decision = plan({
    admissionDownshiftFrom: {
      rejectedRequestedItemCount: 3,
      evidenceRef: 'admission:rejected:three',
    },
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.proposedItemIds, ['item-a']);
  assert.equal(decision.requestedItemCount, 1);
  assert.equal(decision.capacityReason.reasonCode, 'admission_downshift');
  assert.deepEqual(decision.capacityReason.evidenceRefs, [
    'resource-snapshot-1',
    'admission:serial-floor',
    'admission:rejected:three',
  ]);
});

void test('AgentWavePlanner fails visibly when admission state cannot establish the serial floor', () => {
  const decision = plan({
    serialFloorAdmission: {
      kind: 'unknown',
      message: 'subagent admission state unavailable',
      evidenceRef: 'admission:unknown',
    },
  });

  assert.deepEqual(decision, {
    ok: false,
    reasonCode: 'capacity_unknown',
    message: 'subagent admission state unavailable',
    evidenceRefs: ['admission:unknown'],
  });
});

void test('AgentWavePlanner reports missing serial floor admission evidence instead of guessing', () => {
  const planner = createAgentWavePlanner();
  const decision = planner.planNextWave({
    phaseId: 'inspect',
    waveIndex: 0,
    remainingItems: items,
    resourceSnapshot: snapshot,
  });

  assert.deepEqual(decision, {
    ok: false,
    reasonCode: 'capacity_unknown',
    message: 'serial safety floor admission evidence unavailable',
    evidenceRefs: [],
  });
});

void test('AgentWavePlanner rejects invalid explicit policy instead of inventing a width', () => {
  const decision = plan({
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 0,
      policyRef: 'user-policy:invalid',
    },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reasonCode, 'policy_required');
  assert.deepEqual(decision.evidenceRefs, [
    'resource-snapshot-1',
    'user-policy:invalid',
  ]);
});

void test('AgentWavePlanner reports an empty phase without consulting fallback capacity', () => {
  const decision = plan({
    remainingItems: [],
  });

  assert.deepEqual(decision, {
    ok: false,
    reasonCode: 'no_remaining_items',
    message: 'phase inspect has no remaining work items',
    evidenceRefs: ['resource-snapshot-1'],
  });
});

void test('materializeAgentWaveSubagentFunctionCalls builds existing agent_spawn calls without launching', () => {
  const decision = plan({
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-explorers',
    },
  });
  const materialized = materializeAgentWaveSubagentFunctionCalls({
    decision,
    workItems: items,
  });

  assert.equal(materialized.ok, true);
  assert.equal(materialized.functionCalls.length, 2);
  assert.deepEqual(
    materialized.functionCalls.map((call) => call.name),
    ['agent_spawn', 'agent_spawn'],
  );
  assert.deepEqual(
    materialized.functionCalls.map((call) => call.arguments),
    [
      JSON.stringify({
        task: 'Inspect subsystem A',
        subagent_type: 'explorer',
      }),
      JSON.stringify({
        task: 'Inspect subsystem B',
        subagent_type: 'explorer',
      }),
    ],
  );
});

void test('materializeAgentWaveSubagentFunctionCalls fails when a proposed item is missing', () => {
  const decision = plan({
    explicitPolicy: {
      source: 'user',
      requestedItemCount: 2,
      policyRef: 'user-policy:two-explorers',
    },
  });
  const materialized = materializeAgentWaveSubagentFunctionCalls({
    decision,
    workItems: [items[0]!],
  });

  assert.deepEqual(materialized, {
    ok: false,
    reasonCode: 'work_item_not_found',
    message: 'wave proposal references missing work item: item-b',
    itemId: 'item-b',
  });
});

void test('materializeAgentWaveSubagentFunctionCalls rejects duplicate work item ids', () => {
  const decision = plan();
  const materialized = materializeAgentWaveSubagentFunctionCalls({
    decision,
    workItems: [
      items[0]!,
      {
        itemId: 'item-a',
        task: 'Duplicate task',
        subagentType: 'explorer',
      },
    ],
  });

  assert.deepEqual(materialized, {
    ok: false,
    reasonCode: 'duplicate_work_item_id',
    message: 'duplicate wave work item id: item-a',
    itemId: 'item-a',
  });
});

void test('materializeAgentWaveSubagentFunctionCalls rejects empty launch tasks', () => {
  const decision = plan();
  const materialized = materializeAgentWaveSubagentFunctionCalls({
    decision,
    workItems: [
      {
        itemId: 'item-a',
        task: '  ',
        subagentType: 'explorer',
      },
    ],
  });

  assert.deepEqual(materialized, {
    ok: false,
    reasonCode: 'empty_task',
    message: 'wave work item has empty task: item-a',
    itemId: 'item-a',
  });
});
