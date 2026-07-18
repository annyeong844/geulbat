import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAgentLoop } from './run-agent-loop.js';
import { createSubagentRunLauncher } from './subagent-support.js';
import { createRunState } from './runtime/run-state.js';
import { createDaemonContext } from '../context.js';
import type { HistoryItem } from '../llm/index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  composeProviderRounds,
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
  type ProviderRoundFixture,
} from '../../test-support/provider-response-fixtures.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

function functionCallOutput(
  history: readonly HistoryItem[],
  callId: string,
): string {
  for (const item of history) {
    if (item.kind === 'function_call_output' && item.callId === callId) {
      return item.output;
    }
  }
  assert.fail(`expected output for ${callId}`);
}

function readSpawnChildRunId(
  history: readonly HistoryItem[],
  callId: string,
): string {
  const parsed = JSON.parse(functionCallOutput(history, callId)) as {
    ok?: unknown;
    childRunId?: unknown;
    launchState?: unknown;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.launchState, 'started');
  if (typeof parsed.childRunId !== 'string') {
    assert.fail('spawn output childRunId must be a string');
  }
  return parsed.childRunId;
}

function readCompletedWaitResults(
  history: readonly HistoryItem[],
  callId: string,
): string[] {
  const parsed = JSON.parse(functionCallOutput(history, callId)) as {
    ok?: unknown;
    completed?: Array<{ ok?: unknown; result?: unknown }>;
    pending?: unknown[];
    blocked?: unknown[];
  };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.pending, []);
  assert.deepEqual(parsed.blocked, []);
  if (!Array.isArray(parsed.completed)) {
    assert.fail('agent_wait output completed must be an array');
  }
  return parsed.completed.map((entry) => {
    assert.equal(entry.ok, true);
    if (typeof entry.result !== 'string') {
      assert.fail('agent_wait completed result must be a string');
    }
    return entry.result;
  });
}

async function runSubagentLoopScenario(args: {
  threadIdNumber: number;
  prompt: string;
  rounds: ProviderRoundFixture[];
  providerModel?: NonNullable<
    Parameters<typeof runAgentLoop>[0]['providerModel']
  >;
  reasoningEffort?: NonNullable<
    Parameters<typeof runAgentLoop>[0]['reasoningEffort']
  >;
}): Promise<{
  childPrompts: string[];
  childProviderSelections: Array<{
    providerModel: Parameters<typeof runAgentLoop>[0]['providerModel'];
    reasoningEffort: Parameters<typeof runAgentLoop>[0]['reasoningEffort'];
  }>;
  finalProse: string;
}> {
  const threadId = testThreadId(args.threadIdNumber);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-subagent-phase-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: testRunId(`loop-subagent-phase-${args.threadIdNumber}`),
    runContext,
  });
  const childPrompts: string[] = [];
  const childProviderSelections: Array<{
    providerModel: Parameters<typeof runAgentLoop>[0]['providerModel'];
    reasoningEffort: Parameters<typeof runAgentLoop>[0]['reasoningEffort'];
  }> = [];

  daemonContext.subagentRuns = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      childPrompts.push(input.prompt);
      childProviderSelections.push({
        providerModel: input.providerModel,
        reasoningEffort: input.reasoningEffort,
      });
      // Wait-result text stays task-scoped so parent assertions remain stable
      // even when the model-facing child prompt includes shared context.
      const task = extractTrailingTask(input.prompt);
      return {
        ok: true,
        finalProse: `child complete: ${task}`,
      };
    },
  });

  const result = await runAgentLoop({
    runId: runState.runId,
    runContext,
    prompt: args.prompt,
    runState,
    ...(args.providerModel !== undefined
      ? { providerModel: args.providerModel }
      : {}),
    ...(args.reasoningEffort !== undefined
      ? { reasoningEffort: args.reasoningEffort }
      : {}),
    toolSurface: {
      directRegistryNames: ['agent_spawn', 'agent_wait'],
      allowedRegistryNames: ['agent_spawn', 'agent_wait'],
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      sessionId: `session-loop-subagent-phase-${args.threadIdNumber}`,
    }),
    callModelImpl: createScriptedProviderCallModel(args.rounds),
    onEvent: () => {},
  });

  assert.deepEqual(result.ok, true);
  assert.equal(runState.status, 'completed');
  return {
    childPrompts,
    childProviderSelections,
    finalProse: result.finalProse,
  };
}

void test('runAgentLoop records same-round agent_spawn handles for model follow-up', async () => {
  const seenChildRunIds: string[] = [];
  const result = await runSubagentLoopScenario({
    threadIdNumber: 1301,
    prompt: 'spawn two independent inspectors',
    rounds: [
      composeProviderRounds(
        providerToolRound({
          toolName: 'agent_spawn',
          functionCallId: 'fc-inspect-a',
          callId: 'call-inspect-a',
          argumentsJson: JSON.stringify({
            task: 'Inspect subsystem A',
            subagent_type: 'explorer',
          }),
        }),
        providerToolRound({
          toolName: 'agent_spawn',
          functionCallId: 'fc-inspect-b',
          callId: 'call-inspect-b',
          argumentsJson: JSON.stringify({
            task: 'Inspect subsystem B',
            subagent_type: 'explorer',
          }),
        }),
      ),
      {
        ...providerFinalAnswerRound('handles recorded'),
        inspectInput(input) {
          seenChildRunIds.push(
            readSpawnChildRunId(input.history, 'call-inspect-a'),
            readSpawnChildRunId(input.history, 'call-inspect-b'),
          );
        },
      },
    ],
  });

  assert.equal(result.finalProse, 'handles recorded');
  assert.equal(new Set(seenChildRunIds).size, 2);
  assertPromptsCarryTasks(result.childPrompts, [
    'Inspect subsystem A',
    'Inspect subsystem B',
  ]);
});

void test('runAgentLoop threads parent provider selection into spawned children', async () => {
  // The live incident: parent on grok, children silently on the daemon
  // default provider. Keep this on the grok route.
  const providerModel = {
    providerId: 'grok_oauth',
    model: 'grok-4.5',
  } as const;
  const result = await runSubagentLoopScenario({
    threadIdNumber: 1304,
    prompt: 'spawn an inspector on the parent provider',
    providerModel,
    reasoningEffort: 'high',
    rounds: [
      providerToolRound({
        toolName: 'agent_spawn',
        functionCallId: 'fc-inspect-provider',
        callId: 'call-inspect-provider',
        argumentsJson: JSON.stringify({
          task: 'Inspect subsystem A',
          subagent_type: 'explorer',
        }),
      }),
      providerFinalAnswerRound('provider threaded'),
    ],
  });

  assert.equal(result.finalProse, 'provider threaded');
  assert.deepEqual(result.childProviderSelections, [
    { providerModel, reasoningEffort: 'high' },
  ]);
});

void test('runAgentLoop returns completed child output through agent_wait', async () => {
  let childRunId = '';
  const waitRound: ProviderRoundFixture = {
    events: [],
    inspectInput(input) {
      childRunId = readSpawnChildRunId(input.history, 'call-inspect');
      waitRound.events =
        providerToolRound({
          toolName: 'agent_wait',
          functionCallId: 'fc-wait-inspect',
          callId: 'call-wait-inspect',
          argumentsJson: JSON.stringify({
            child_run_ids: [childRunId],
            wait_mode: 'all',
          }),
        }).events ?? [];
    },
  };

  const result = await runSubagentLoopScenario({
    threadIdNumber: 1302,
    prompt: 'spawn an inspector and wait for it',
    rounds: [
      providerToolRound({
        toolName: 'agent_spawn',
        functionCallId: 'fc-inspect',
        callId: 'call-inspect',
        argumentsJson: JSON.stringify({
          task: 'Inspect subsystem A',
          subagent_type: 'explorer',
        }),
      }),
      waitRound,
      {
        ...providerFinalAnswerRound('wait observed'),
        inspectInput(input) {
          assert.deepEqual(
            readCompletedWaitResults(input.history, 'call-wait-inspect'),
            ['child complete: Inspect subsystem A'],
          );
        },
      },
    ],
  });

  assert.equal(result.finalProse, 'wait observed');
  assertPromptsCarryTasks(result.childPrompts, ['Inspect subsystem A']);
});

void test('runAgentLoop starts a dependent subagent only after wait output is visible', async () => {
  let inspectionChildRunId = '';
  let sawInspectionWaitOutput = false;
  const waitRound: ProviderRoundFixture = {
    events: [],
    inspectInput(input) {
      inspectionChildRunId = readSpawnChildRunId(input.history, 'call-inspect');
      waitRound.events =
        providerToolRound({
          toolName: 'agent_wait',
          functionCallId: 'fc-wait-inspect',
          callId: 'call-wait-inspect',
          argumentsJson: JSON.stringify({
            child_run_ids: [inspectionChildRunId],
            wait_mode: 'all',
          }),
        }).events ?? [];
    },
  };
  const dependentSpawnRound: ProviderRoundFixture = {
    events: [],
    inspectInput(input) {
      assert.deepEqual(
        readCompletedWaitResults(input.history, 'call-wait-inspect'),
        ['child complete: Inspect subsystem A'],
      );
      sawInspectionWaitOutput = true;
      dependentSpawnRound.events =
        providerToolRound({
          toolName: 'agent_spawn',
          functionCallId: 'fc-verify',
          callId: 'call-verify',
          argumentsJson: JSON.stringify({
            task: 'Verify subsystem A finding',
            subagent_type: 'explorer',
          }),
        }).events ?? [];
    },
  };

  const result = await runSubagentLoopScenario({
    threadIdNumber: 1303,
    prompt: 'inspect, wait, then verify',
    rounds: [
      providerToolRound({
        toolName: 'agent_spawn',
        functionCallId: 'fc-inspect',
        callId: 'call-inspect',
        argumentsJson: JSON.stringify({
          task: 'Inspect subsystem A',
          subagent_type: 'explorer',
        }),
      }),
      waitRound,
      dependentSpawnRound,
      {
        ...providerFinalAnswerRound('dependent phase started'),
        inspectInput(input) {
          assert.equal(sawInspectionWaitOutput, true);
          assert.equal(
            typeof readSpawnChildRunId(input.history, 'call-verify'),
            'string',
          );
        },
      },
    ],
  });

  assert.equal(result.finalProse, 'dependent phase started');
  assertPromptsCarryTasks(result.childPrompts, [
    'Inspect subsystem A',
    'Verify subsystem A finding',
  ]);
});

function extractTrailingTask(prompt: string): string {
  const parts = prompt.split('\n\n');
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? prompt : last;
}

function promptCarriesTask(prompt: string, task: string): boolean {
  return (
    prompt === task || prompt.endsWith(`\n\n${task}`) || prompt.endsWith(task)
  );
}

function assertPromptsCarryTasks(
  prompts: readonly string[],
  tasks: readonly string[],
): void {
  assert.equal(
    prompts.length,
    tasks.length,
    `expected ${tasks.length} child prompts, got ${prompts.length}`,
  );
  const remaining = [...prompts];
  for (const task of tasks) {
    const index = remaining.findIndex((prompt) =>
      promptCarriesTask(prompt, task),
    );
    assert.ok(
      index >= 0,
      `expected a child prompt carrying task ${JSON.stringify(task)}, got ${JSON.stringify(prompts)}`,
    );
    remaining.splice(index, 1);
  }
}
