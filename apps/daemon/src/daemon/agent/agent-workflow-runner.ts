import type {
  AgentWaveCapacityReasonCode,
  AgentWaveDecision,
  AgentWaveExplicitPolicy,
  AgentWavePlanner,
  AgentWaveSerialFloorAdmission,
  AgentWaveWorkItem,
} from './agent-wave-planner.js';
import { materializeAgentWaveSubagentFunctionCalls } from './agent-wave-planner.js';
import type {
  ResourceBudgetProvider,
  ResourceBudgetSnapshot,
} from './resource-budget-provider.js';
import type { HistoryItem, FunctionCall } from '../llm/index.js';
import { tryParseJson } from '../runtime-json.js';
import type { ToolRunState } from '../runtime-contracts.js';
import type { RunId } from './contract.js';
import { isAgentRunId } from './contract.js';
import {
  getToolRuntimeRunState,
  type AgentToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { waitForAgentChildren } from '../tools/agent-child-wait.js';
import { isAgentLaunchToolRaw } from '../subagent-runtime-contracts.js';

type MaybePromise<T> = T | Promise<T>;

export type AgentWorkflowWaveAttemptKind = 'planned' | 'admission_downshift';

export type AgentWorkflowFailureReasonCode =
  | 'capacity_unknown'
  | 'admission_rejected'
  | 'policy_required'
  | 'no_remaining_items'
  | 'workflow_cancelled'
  | 'workflow_backstop_exceeded'
  | 'wave_blocked'
  | 'wave_execution_failed'
  | 'wave_no_progress';

export type AgentWorkflowWaveLaunchResult =
  | {
      readonly ok: true;
      readonly completedItemIds: readonly string[];
      readonly telemetryRefs?: readonly string[];
      readonly evidenceRefs?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'admission_rejected'
        | 'wave_blocked'
        | 'wave_execution_failed';
      readonly message: string;
      readonly evidenceRefs: readonly string[];
    };

export interface AgentWorkflowWaveAttempt {
  readonly phaseId: string;
  readonly waveIndex: number;
  readonly attemptKind: AgentWorkflowWaveAttemptKind;
  readonly decision: Extract<AgentWaveDecision, { ok: true }>;
  readonly selectedItemIds: readonly string[];
  readonly launch:
    | {
        readonly ok: true;
        readonly completedItemIds: readonly string[];
        readonly telemetryRefs: readonly string[];
        readonly evidenceRefs: readonly string[];
      }
    | {
        readonly ok: false;
        readonly reasonCode: AgentWorkflowFailureReasonCode;
        readonly message: string;
        readonly evidenceRefs: readonly string[];
      };
}

export interface AgentWorkflowPhaseTelemetry {
  readonly recordedWaveAttempts: number;
  readonly serialSafetyFloorAttempts: number;
  readonly widenedAttempts: number;
  readonly admissionDownshiftAttempts: number;
}

export type AgentWorkflowCapacitySource =
  | 'explicit_policy'
  | 'observed_resources'
  | 'telemetry'
  | 'serial_safety_floor'
  | 'admission_downshift'
  | 'unknown';

export type AgentWorkflowPhaseProgressStatus =
  | 'pending'
  | 'completed'
  | 'failed';

export interface AgentWorkflowPhaseProgress {
  readonly phaseId: string;
  readonly status: AgentWorkflowPhaseProgressStatus;
  readonly waveAttemptCount: number;
  readonly launchedItemCount: number;
  readonly completedItemCount: number;
  readonly waitingItemCount: number;
  readonly totalItemCount: number;
  readonly capacitySource: AgentWorkflowCapacitySource;
  readonly capacityReasonCode?: AgentWaveCapacityReasonCode;
}

export type AgentWorkflowPhaseResult =
  | {
      readonly ok: true;
      readonly phaseId: string;
      readonly completedItemIds: readonly string[];
      readonly waves: readonly AgentWorkflowWaveAttempt[];
      readonly telemetry: AgentWorkflowPhaseTelemetry;
      readonly progress: AgentWorkflowPhaseProgress;
    }
  | {
      readonly ok: false;
      readonly phaseId: string;
      readonly reasonCode: AgentWorkflowFailureReasonCode;
      readonly message: string;
      readonly evidenceRefs: readonly string[];
      readonly waves: readonly AgentWorkflowWaveAttempt[];
      readonly telemetry: AgentWorkflowPhaseTelemetry;
      readonly progress: AgentWorkflowPhaseProgress;
    };

export interface AgentWorkflowInput {
  readonly phases: readonly AgentWorkflowPhaseInput[];
}

export type AgentWorkflowResult =
  | {
      readonly ok: true;
      readonly completedPhaseIds: readonly string[];
      readonly progress: readonly AgentWorkflowPhaseProgress[];
      readonly phaseResults: readonly Extract<
        AgentWorkflowPhaseResult,
        { ok: true }
      >[];
    }
  | {
      readonly ok: false;
      readonly failedPhaseId: string;
      readonly reasonCode: AgentWorkflowFailureReasonCode;
      readonly message: string;
      readonly evidenceRefs: readonly string[];
      readonly progress: readonly AgentWorkflowPhaseProgress[];
      readonly phaseResults: readonly AgentWorkflowPhaseResult[];
    };

export interface AgentWorkflowPhaseInput {
  readonly phaseId: string;
  readonly workItems: readonly AgentWaveWorkItem[];
  readonly runState?: ToolRunState;
  readonly explicitPolicy?: AgentWaveExplicitPolicy;
  readonly admitSerialFloor: (args: {
    phaseId: string;
    waveIndex: number;
    remainingItems: readonly AgentWaveWorkItem[];
    resourceSnapshot: ResourceBudgetSnapshot;
  }) => MaybePromise<AgentWaveSerialFloorAdmission>;
  readonly launchWave: (args: {
    phaseId: string;
    waveIndex: number;
    attemptKind: AgentWorkflowWaveAttemptKind;
    decision: Extract<AgentWaveDecision, { ok: true }>;
    selectedItems: readonly AgentWaveWorkItem[];
    resourceSnapshot: ResourceBudgetSnapshot;
  }) => Promise<AgentWorkflowWaveLaunchResult>;
}

export interface AgentWorkflowRunner {
  runPhase(input: AgentWorkflowPhaseInput): Promise<AgentWorkflowPhaseResult>;
  runWorkflow(input: AgentWorkflowInput): Promise<AgentWorkflowResult>;
}

export interface AgentWorkflowSubagentWaveLaunchArgs {
  readonly phaseId: string;
  readonly waveIndex: number;
  readonly attemptKind: AgentWorkflowWaveAttemptKind;
  readonly decision: Extract<AgentWaveDecision, { ok: true }>;
  readonly selectedItems: readonly AgentWaveWorkItem[];
  readonly resourceSnapshot: ResourceBudgetSnapshot;
  readonly round: number;
  readonly history: HistoryItem[];
  readonly runtime: AgentToolCallExecutionRuntime;
  readonly signal?: AbortSignal;
}

export interface AgentWorkflowSubagentPhaseRunArgs {
  readonly phaseId: string;
  readonly workItems: readonly AgentWaveWorkItem[];
  readonly history: HistoryItem[];
  readonly runtime: AgentToolCallExecutionRuntime;
  readonly runState?: ToolRunState;
  readonly explicitPolicy?: AgentWaveExplicitPolicy;
  readonly signal?: AbortSignal;
}

export interface AgentWorkflowSubagentWorkflowPhaseRunInput {
  readonly phaseId: string;
  readonly workItems: readonly AgentWaveWorkItem[];
  readonly explicitPolicy?: AgentWaveExplicitPolicy;
}

export interface AgentWorkflowSubagentWorkflowRunArgs {
  readonly phases: readonly AgentWorkflowSubagentWorkflowPhaseRunInput[];
  readonly history: HistoryItem[];
  readonly runtime: AgentToolCallExecutionRuntime;
  readonly runState?: ToolRunState;
  readonly signal?: AbortSignal;
}

export function createAgentWorkflowRunner(options: {
  agentWavePlanner: AgentWavePlanner;
  resourceBudgetProvider: ResourceBudgetProvider;
}): AgentWorkflowRunner {
  return {
    runPhase(input) {
      return runAgentWorkflowPhase(input, options);
    },
    runWorkflow(input) {
      return runAgentWorkflow(input, options);
    },
  };
}

export async function runAgentWorkflowWithSubagents(
  args: AgentWorkflowSubagentWorkflowRunArgs,
): Promise<AgentWorkflowResult> {
  const agentRuntime = args.runtime.executionContextBase.agentSpawnRuntime;
  if (agentRuntime === undefined) {
    return failWorkflowRuntimeMissing(args.phases);
  }

  const runState = args.runState ?? getToolRuntimeRunState(args.runtime);
  return await agentRuntime.agentWorkflowRunner.runWorkflow({
    phases: buildSubagentWorkflowPhaseInputs({
      phases: args.phases,
      history: args.history,
      runtime: args.runtime,
      ...(runState !== undefined ? { runState } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    }),
  });
}

export async function runAgentWorkflowPhaseWithSubagents(
  args: AgentWorkflowSubagentPhaseRunArgs,
): Promise<AgentWorkflowPhaseResult> {
  const agentRuntime = args.runtime.executionContextBase.agentSpawnRuntime;
  if (agentRuntime === undefined) {
    return failPhase({
      phaseId: args.phaseId,
      workItems: args.workItems,
      reasonCode: 'capacity_unknown',
      message: 'agent spawn runtime is required for workflow phase execution',
      evidenceRefs: [
        `agent-workflow:${args.phaseId}:phase-runtime:runtime-missing`,
      ],
      waves: [],
    });
  }

  const runState = args.runState ?? getToolRuntimeRunState(args.runtime);
  return await agentRuntime.agentWorkflowRunner.runPhase(
    buildSubagentWorkflowPhaseInput({
      phase: {
        phaseId: args.phaseId,
        workItems: args.workItems,
        ...(args.explicitPolicy !== undefined
          ? { explicitPolicy: args.explicitPolicy }
          : {}),
      },
      history: args.history,
      runtime: args.runtime,
      ...(runState !== undefined ? { runState } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    }),
  );
}

export function admitAgentWorkflowSerialFloor(args: {
  phaseId: string;
  waveIndex: number;
  runtime: AgentToolCallExecutionRuntime;
}): AgentWaveSerialFloorAdmission {
  const agentRuntime = args.runtime.executionContextBase.agentSpawnRuntime;
  if (agentRuntime === undefined) {
    return {
      kind: 'unknown',
      message:
        'agent spawn runtime is required for workflow serial floor admission',
      evidenceRef: buildSerialFloorAdmissionEvidenceRef(
        args,
        'runtime-missing',
      ),
    };
  }

  const runState = getToolRuntimeRunState(args.runtime);
  if (runState === undefined) {
    return {
      kind: 'unknown',
      message: 'run state is required for workflow serial floor admission',
      evidenceRef: buildSerialFloorAdmissionEvidenceRef(
        args,
        'run-state-missing',
      ),
    };
  }

  const admission = agentRuntime.subagentAdmission.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
  });
  if (!admission.ok) {
    return {
      kind: 'rejected',
      message: admission.error,
      evidenceRef: buildSerialFloorAdmissionEvidenceRef(
        args,
        admission.errorCode,
      ),
    };
  }

  admission.reservation.release();
  return {
    kind: 'admitted',
    evidenceRef: buildSerialFloorAdmissionEvidenceRef(args, 'admitted'),
  };
}

export async function launchAgentWorkflowWaveWithSubagents(
  args: AgentWorkflowSubagentWaveLaunchArgs,
): Promise<AgentWorkflowWaveLaunchResult> {
  const agentRuntime = args.runtime.executionContextBase.agentSpawnRuntime;
  if (agentRuntime === undefined) {
    return failWaveLaunch({
      reasonCode: 'wave_execution_failed',
      message: 'agent spawn runtime is required for workflow wave launch',
      evidenceRefs: [args.decision.resourceSnapshotId],
    });
  }

  const materialized = materializeAgentWaveSubagentFunctionCalls({
    decision: args.decision,
    workItems: args.selectedItems,
  });
  if (!materialized.ok) {
    return failWaveLaunch({
      reasonCode: 'wave_execution_failed',
      message: materialized.message,
      evidenceRefs: [args.decision.resourceSnapshotId],
    });
  }

  const historyStartIndex = args.history.length;
  const processing = await processFunctionCalls({
    functionCalls: [...materialized.functionCalls],
    round: args.round,
    history: args.history,
    runtime: args.runtime,
  });
  if (!processing.ok) {
    return failWaveLaunch({
      reasonCode: 'wave_execution_failed',
      message:
        processing.result.finalProse ||
        'workflow wave launch failed before child results were available',
      evidenceRefs: [args.decision.resourceSnapshotId],
    });
  }

  const launched = readLaunchedChildRunIds({
    functionCalls: materialized.functionCalls,
    history: args.history,
    historyStartIndex,
  });
  if (!launched.ok) {
    return launched;
  }

  const wait = await waitForAgentChildren({
    registry: agentRuntime.childRuns,
    ownerThreadId: args.runtime.executionContextBase.threadId,
    childRunIds: launched.childRunIds,
    waitMode: 'all',
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  if (!wait.ok) {
    return failWaveLaunch({
      reasonCode: 'wave_execution_failed',
      message: wait.message,
      evidenceRefs: launched.evidenceRefs,
    });
  }
  agentRuntime.childRuns.claimTerminalChildRuns({
    ownerThreadId: args.runtime.executionContextBase.threadId,
    childRunIds: wait.result.completed.map((result) => result.childRunId),
  });

  const failedChild = wait.result.completed.find((result) => !result.ok);
  if (failedChild !== undefined) {
    return failWaveLaunch({
      reasonCode: 'wave_execution_failed',
      message:
        failedChild.result ||
        `child run ${failedChild.childRunId} ended as ${failedChild.terminalState}`,
      evidenceRefs: [
        ...launched.evidenceRefs,
        `child-run:${failedChild.childRunId}`,
      ],
    });
  }

  const blockedChild = wait.result.blocked[0];
  if (blockedChild !== undefined) {
    return failWaveLaunch({
      reasonCode: 'wave_blocked',
      message: `child run ${blockedChild.childRunId} is blocked: ${blockedChild.blockedReason}`,
      evidenceRefs: [
        ...launched.evidenceRefs,
        `child-run:${blockedChild.childRunId}:blocked:${blockedChild.blockedReason}`,
      ],
    });
  }

  return {
    ok: true,
    completedItemIds: args.selectedItems.map((item) => item.itemId),
    evidenceRefs: launched.evidenceRefs,
  };
}

export async function runAgentWorkflowPhase(
  input: AgentWorkflowPhaseInput,
  runtime: {
    agentWavePlanner: AgentWavePlanner;
    resourceBudgetProvider: ResourceBudgetProvider;
  },
): Promise<AgentWorkflowPhaseResult> {
  let remainingItems = [...input.workItems];
  const completedItemIds: string[] = [];
  const waves: AgentWorkflowWaveAttempt[] = [];
  let previousWaveTelemetryRefs: readonly string[] = [];
  let waveIndex = 0;

  while (remainingItems.length > 0) {
    const resourceSnapshot = runtime.resourceBudgetProvider.captureSnapshot({
      ...(input.runState !== undefined ? { runState: input.runState } : {}),
    });
    const serialFloorAdmission = await input.admitSerialFloor({
      phaseId: input.phaseId,
      waveIndex,
      remainingItems,
      resourceSnapshot,
    });
    const decision = runtime.agentWavePlanner.planNextWave({
      phaseId: input.phaseId,
      waveIndex,
      remainingItems,
      resourceSnapshot,
      serialFloorAdmission,
      ...(input.explicitPolicy !== undefined
        ? { explicitPolicy: input.explicitPolicy }
        : {}),
      previousWaveTelemetryRefs,
    });

    const wave = await executeWaveDecision({
      input,
      decision,
      attemptKind: 'planned',
      remainingItems,
      resourceSnapshot,
    });
    waves.push(...wave.waves);

    if (!wave.ok && shouldDownshiftAfterAdmissionRejection(decision, wave)) {
      const downshift = await executeAdmissionDownshift({
        input,
        rejectedDecision: decision,
        remainingItems,
        resourceSnapshot,
        serialFloorAdmission,
        previousWaveTelemetryRefs,
        rejectedEvidenceRefs: wave.evidenceRefs,
        runtime,
      });
      waves.push(...downshift.waves);
      if (!downshift.ok) {
        return failPhase({
          phaseId: input.phaseId,
          workItems: input.workItems,
          reasonCode: downshift.reasonCode,
          message: downshift.message,
          evidenceRefs: downshift.evidenceRefs,
          waves,
        });
      }
      completedItemIds.push(...downshift.completedItemIds);
      remainingItems = removeCompletedItems({
        remainingItems,
        completedItemIds: downshift.completedItemIds,
      });
      previousWaveTelemetryRefs = downshift.telemetryRefs;
      waveIndex += 1;
      continue;
    }

    if (!wave.ok) {
      return failPhase({
        phaseId: input.phaseId,
        workItems: input.workItems,
        reasonCode: wave.reasonCode,
        message: wave.message,
        evidenceRefs: wave.evidenceRefs,
        waves,
      });
    }

    completedItemIds.push(...wave.completedItemIds);
    remainingItems = removeCompletedItems({
      remainingItems,
      completedItemIds: wave.completedItemIds,
    });
    previousWaveTelemetryRefs = wave.telemetryRefs;
    waveIndex += 1;
  }

  return {
    ok: true,
    phaseId: input.phaseId,
    completedItemIds,
    waves,
    telemetry: buildPhaseTelemetry(waves),
    progress: buildPhaseProgress({
      phaseId: input.phaseId,
      status: 'completed',
      workItems: input.workItems,
      waves,
    }),
  };
}

export async function runAgentWorkflow(
  input: AgentWorkflowInput,
  runtime: {
    agentWavePlanner: AgentWavePlanner;
    resourceBudgetProvider: ResourceBudgetProvider;
  },
): Promise<AgentWorkflowResult> {
  const phaseResults: AgentWorkflowPhaseResult[] = [];
  const completedPhaseResults: Extract<
    AgentWorkflowPhaseResult,
    { ok: true }
  >[] = [];

  for (const phase of input.phases) {
    const phaseResult = await runAgentWorkflowPhase(phase, runtime);
    phaseResults.push(phaseResult);
    if (!phaseResult.ok) {
      return {
        ok: false,
        failedPhaseId: phaseResult.phaseId,
        reasonCode: phaseResult.reasonCode,
        message: phaseResult.message,
        evidenceRefs: phaseResult.evidenceRefs,
        progress: buildWorkflowProgress({
          phases: input.phases,
          phaseResults,
        }),
        phaseResults,
      };
    }
    completedPhaseResults.push(phaseResult);
  }

  return {
    ok: true,
    completedPhaseIds: completedPhaseResults.map((phase) => phase.phaseId),
    progress: buildWorkflowProgress({
      phases: input.phases,
      phaseResults: completedPhaseResults,
    }),
    phaseResults: completedPhaseResults,
  };
}

async function executeAdmissionDownshift(args: {
  input: AgentWorkflowPhaseInput;
  rejectedDecision: Extract<AgentWaveDecision, { ok: true }>;
  remainingItems: readonly AgentWaveWorkItem[];
  resourceSnapshot: ResourceBudgetSnapshot;
  serialFloorAdmission: AgentWaveSerialFloorAdmission;
  previousWaveTelemetryRefs: readonly string[];
  rejectedEvidenceRefs: readonly string[];
  runtime: {
    agentWavePlanner: AgentWavePlanner;
  };
}): Promise<WaveExecutionResult> {
  const rejectedEvidenceRef =
    args.rejectedEvidenceRefs[0] ??
    `${args.input.phaseId}:wave:${args.rejectedDecision.waveIndex}:admission-rejected`;
  const downshiftDecision = args.runtime.agentWavePlanner.planNextWave({
    phaseId: args.input.phaseId,
    waveIndex: args.rejectedDecision.waveIndex,
    remainingItems: args.remainingItems,
    resourceSnapshot: args.resourceSnapshot,
    serialFloorAdmission: args.serialFloorAdmission,
    admissionDownshiftFrom: {
      rejectedRequestedItemCount: args.rejectedDecision.requestedItemCount,
      evidenceRef: rejectedEvidenceRef,
    },
    previousWaveTelemetryRefs: args.previousWaveTelemetryRefs,
  });

  return await executeWaveDecision({
    input: args.input,
    decision: downshiftDecision,
    attemptKind: 'admission_downshift',
    remainingItems: args.remainingItems,
    resourceSnapshot: args.resourceSnapshot,
  });
}

type WaveExecutionResult =
  | {
      readonly ok: true;
      readonly completedItemIds: readonly string[];
      readonly telemetryRefs: readonly string[];
      readonly waves: readonly AgentWorkflowWaveAttempt[];
    }
  | {
      readonly ok: false;
      readonly reasonCode: AgentWorkflowFailureReasonCode;
      readonly message: string;
      readonly evidenceRefs: readonly string[];
      readonly waves: readonly AgentWorkflowWaveAttempt[];
    };

async function executeWaveDecision(args: {
  input: AgentWorkflowPhaseInput;
  decision: AgentWaveDecision;
  attemptKind: AgentWorkflowWaveAttemptKind;
  remainingItems: readonly AgentWaveWorkItem[];
  resourceSnapshot: ResourceBudgetSnapshot;
}): Promise<WaveExecutionResult> {
  if (!args.decision.ok) {
    return {
      ok: false,
      reasonCode: args.decision.reasonCode,
      message: args.decision.message,
      evidenceRefs: args.decision.evidenceRefs,
      waves: [],
    };
  }

  const selectedItems = selectProposedItems({
    decision: args.decision,
    remainingItems: args.remainingItems,
  });
  if (!selectedItems.ok) {
    return {
      ok: false,
      reasonCode: 'wave_execution_failed',
      message: selectedItems.message,
      evidenceRefs: [args.decision.resourceSnapshotId],
      waves: [],
    };
  }

  const launch = await args.input.launchWave({
    phaseId: args.input.phaseId,
    waveIndex: args.decision.waveIndex,
    attemptKind: args.attemptKind,
    decision: args.decision,
    selectedItems: selectedItems.items,
    resourceSnapshot: args.resourceSnapshot,
  });
  const attempt = buildWaveAttempt({
    phaseId: args.input.phaseId,
    attemptKind: args.attemptKind,
    decision: args.decision,
    selectedItemIds: selectedItems.items.map((item) => item.itemId),
    launch,
  });

  if (!launch.ok) {
    return {
      ok: false,
      reasonCode: launch.reasonCode,
      message: launch.message,
      evidenceRefs: launch.evidenceRefs,
      waves: [attempt],
    };
  }

  const completed = validateCompletedItems({
    proposedItemIds: args.decision.proposedItemIds,
    completedItemIds: launch.completedItemIds,
  });
  if (!completed.ok) {
    return {
      ok: false,
      reasonCode: completed.reasonCode,
      message: completed.message,
      evidenceRefs: launch.evidenceRefs ?? [args.decision.resourceSnapshotId],
      waves: [attempt],
    };
  }

  return {
    ok: true,
    completedItemIds: completed.completedItemIds,
    telemetryRefs: launch.telemetryRefs ?? [],
    waves: [attempt],
  };
}

type LaunchedChildRunIdsResult =
  | {
      readonly ok: true;
      readonly childRunIds: readonly RunId[];
      readonly evidenceRefs: readonly string[];
    }
  | Extract<AgentWorkflowWaveLaunchResult, { ok: false }>;

function readLaunchedChildRunIds(args: {
  functionCalls: readonly FunctionCall[];
  history: readonly HistoryItem[];
  historyStartIndex: number;
}): LaunchedChildRunIdsResult {
  const childRunIds: RunId[] = [];
  const evidenceRefs: string[] = [];
  for (const functionCall of args.functionCalls) {
    const output = findFunctionCallOutput({
      callId: functionCall.callId,
      history: args.history,
      historyStartIndex: args.historyStartIndex,
    });
    if (output === undefined) {
      return failWaveLaunch({
        reasonCode: 'wave_execution_failed',
        message: `workflow wave launch did not record a result for ${functionCall.callId}`,
        evidenceRefs: [functionCall.callId],
      });
    }

    const parsed = tryParseJson(output);
    if (!parsed.ok || !isAgentLaunchToolRaw(parsed.value)) {
      return failWaveLaunch({
        reasonCode: 'wave_execution_failed',
        message: `workflow wave launch returned an invalid agent_spawn payload for ${functionCall.callId}`,
        evidenceRefs: [functionCall.callId],
      });
    }

    if (!parsed.value.ok) {
      return failWaveLaunch({
        reasonCode:
          parsed.value.errorCode === 'too_many_child_runs'
            ? 'admission_rejected'
            : 'wave_execution_failed',
        message: parsed.value.error,
        evidenceRefs: [functionCall.callId],
      });
    }

    if (!isAgentRunId(parsed.value.childRunId)) {
      return failWaveLaunch({
        reasonCode: 'wave_execution_failed',
        message: `workflow wave launch returned an invalid child run id for ${functionCall.callId}`,
        evidenceRefs: [functionCall.callId],
      });
    }

    childRunIds.push(parsed.value.childRunId);
    evidenceRefs.push(
      functionCall.callId,
      `child-run:${parsed.value.childRunId}`,
    );
  }

  return {
    ok: true,
    childRunIds,
    evidenceRefs,
  };
}

function findFunctionCallOutput(args: {
  callId: string;
  history: readonly HistoryItem[];
  historyStartIndex: number;
}): string | undefined {
  for (const item of args.history.slice(args.historyStartIndex)) {
    if (item.kind === 'function_call_output' && item.callId === args.callId) {
      return item.output;
    }
  }
  return undefined;
}

function failWaveLaunch(failure: {
  readonly reasonCode:
    | 'admission_rejected'
    | 'wave_blocked'
    | 'wave_execution_failed';
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}): Extract<AgentWorkflowWaveLaunchResult, { ok: false }> {
  return {
    ok: false,
    reasonCode: failure.reasonCode,
    message: failure.message,
    evidenceRefs: failure.evidenceRefs,
  };
}

function buildSubagentWorkflowPhaseInputs(args: {
  readonly phases: readonly AgentWorkflowSubagentWorkflowPhaseRunInput[];
  readonly history: HistoryItem[];
  readonly runtime: AgentToolCallExecutionRuntime;
  readonly runState?: ToolRunState;
  readonly signal?: AbortSignal;
}): AgentWorkflowPhaseInput[] {
  return args.phases.map((phase) =>
    buildSubagentWorkflowPhaseInput({ ...args, phase }),
  );
}

function buildSubagentWorkflowPhaseInput(args: {
  readonly phase: AgentWorkflowSubagentWorkflowPhaseRunInput;
  readonly history: HistoryItem[];
  readonly runtime: AgentToolCallExecutionRuntime;
  readonly runState?: ToolRunState;
  readonly signal?: AbortSignal;
}): AgentWorkflowPhaseInput {
  return {
    phaseId: args.phase.phaseId,
    workItems: args.phase.workItems,
    ...(args.runState !== undefined ? { runState: args.runState } : {}),
    ...(args.phase.explicitPolicy !== undefined
      ? { explicitPolicy: args.phase.explicitPolicy }
      : {}),
    admitSerialFloor: ({ phaseId, waveIndex }) =>
      admitAgentWorkflowSerialFloor({
        phaseId,
        waveIndex,
        runtime: args.runtime,
      }),
    async launchWave(waveArgs) {
      return await launchAgentWorkflowWaveWithSubagents({
        ...waveArgs,
        round: waveArgs.waveIndex,
        history: args.history,
        runtime: args.runtime,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    },
  };
}

function buildSerialFloorAdmissionEvidenceRef(
  args: Pick<AgentWorkflowSubagentWaveLaunchArgs, 'phaseId' | 'waveIndex'>,
  outcome: string,
): string {
  return `agent-workflow:${args.phaseId}:wave:${args.waveIndex}:serial-floor:${outcome}`;
}

function shouldDownshiftAfterAdmissionRejection(
  decision: AgentWaveDecision,
  wave: WaveExecutionResult,
): decision is Extract<AgentWaveDecision, { ok: true }> {
  return (
    decision.ok &&
    decision.requestedItemCount > 1 &&
    !wave.ok &&
    wave.reasonCode === 'admission_rejected'
  );
}

function selectProposedItems(args: {
  decision: Extract<AgentWaveDecision, { ok: true }>;
  remainingItems: readonly AgentWaveWorkItem[];
}):
  | {
      readonly ok: true;
      readonly items: readonly AgentWaveWorkItem[];
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const byId = new Map(args.remainingItems.map((item) => [item.itemId, item]));
  const items: AgentWaveWorkItem[] = [];
  for (const itemId of args.decision.proposedItemIds) {
    const item = byId.get(itemId);
    if (item === undefined) {
      return {
        ok: false,
        message: `wave decision references missing work item: ${itemId}`,
      };
    }
    items.push(item);
  }
  return { ok: true, items };
}

function validateCompletedItems(args: {
  proposedItemIds: readonly string[];
  completedItemIds: readonly string[];
}):
  | {
      readonly ok: true;
      readonly completedItemIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'wave_execution_failed' | 'wave_no_progress';
      readonly message: string;
    } {
  if (args.completedItemIds.length === 0) {
    return {
      ok: false,
      reasonCode: 'wave_no_progress',
      message: 'wave launch completed without any item result',
    };
  }

  const proposed = new Set(args.proposedItemIds);
  const completed = new Set(args.completedItemIds);
  for (const itemId of completed) {
    if (!proposed.has(itemId)) {
      return {
        ok: false,
        reasonCode: 'wave_execution_failed',
        message: `wave completed an item outside the proposal: ${itemId}`,
      };
    }
  }
  for (const itemId of proposed) {
    if (!completed.has(itemId)) {
      return {
        ok: false,
        reasonCode: 'wave_execution_failed',
        message: `wave did not complete proposed item: ${itemId}`,
      };
    }
  }

  return {
    ok: true,
    completedItemIds: args.proposedItemIds,
  };
}

function removeCompletedItems(args: {
  remainingItems: readonly AgentWaveWorkItem[];
  completedItemIds: readonly string[];
}): AgentWaveWorkItem[] {
  const completed = new Set(args.completedItemIds);
  return args.remainingItems.filter((item) => !completed.has(item.itemId));
}

function buildWaveAttempt(args: {
  phaseId: string;
  attemptKind: AgentWorkflowWaveAttemptKind;
  decision: Extract<AgentWaveDecision, { ok: true }>;
  selectedItemIds: readonly string[];
  launch: AgentWorkflowWaveLaunchResult;
}): AgentWorkflowWaveAttempt {
  return {
    phaseId: args.phaseId,
    waveIndex: args.decision.waveIndex,
    attemptKind: args.attemptKind,
    decision: args.decision,
    selectedItemIds: args.selectedItemIds,
    launch: args.launch.ok
      ? {
          ok: true,
          completedItemIds: args.launch.completedItemIds,
          telemetryRefs: args.launch.telemetryRefs ?? [],
          evidenceRefs: args.launch.evidenceRefs ?? [],
        }
      : {
          ok: false,
          reasonCode: args.launch.reasonCode,
          message: args.launch.message,
          evidenceRefs: args.launch.evidenceRefs,
        },
  };
}

function failPhase(args: {
  phaseId: string;
  workItems: readonly AgentWaveWorkItem[];
  reasonCode: AgentWorkflowFailureReasonCode;
  message: string;
  evidenceRefs: readonly string[];
  waves: readonly AgentWorkflowWaveAttempt[];
}): Extract<AgentWorkflowPhaseResult, { ok: false }> {
  return {
    ok: false,
    phaseId: args.phaseId,
    reasonCode: args.reasonCode,
    message: args.message,
    evidenceRefs: args.evidenceRefs,
    waves: args.waves,
    telemetry: buildPhaseTelemetry(args.waves),
    progress: buildPhaseProgress({
      phaseId: args.phaseId,
      status: 'failed',
      workItems: args.workItems,
      waves: args.waves,
    }),
  };
}

function failWorkflowRuntimeMissing(
  phases: readonly AgentWorkflowSubagentWorkflowPhaseRunInput[],
): AgentWorkflowResult {
  const [firstPhase] = phases;
  if (firstPhase === undefined) {
    return {
      ok: true,
      completedPhaseIds: [],
      progress: [],
      phaseResults: [],
    };
  }

  const failedPhase = failPhase({
    phaseId: firstPhase.phaseId,
    workItems: firstPhase.workItems,
    reasonCode: 'capacity_unknown',
    message: 'agent spawn runtime is required for workflow execution',
    evidenceRefs: [
      `agent-workflow:${firstPhase.phaseId}:workflow-runtime:runtime-missing`,
    ],
    waves: [],
  });
  return {
    ok: false,
    failedPhaseId: failedPhase.phaseId,
    reasonCode: failedPhase.reasonCode,
    message: failedPhase.message,
    evidenceRefs: failedPhase.evidenceRefs,
    progress: buildWorkflowProgress({
      phases,
      phaseResults: [failedPhase],
    }),
    phaseResults: [failedPhase],
  };
}

interface AgentWorkflowProgressPhaseInput {
  readonly phaseId: string;
  readonly workItems: readonly AgentWaveWorkItem[];
}

function buildWorkflowProgress(args: {
  phases: readonly AgentWorkflowProgressPhaseInput[];
  phaseResults: readonly AgentWorkflowPhaseResult[];
}): readonly AgentWorkflowPhaseProgress[] {
  return args.phases.map((phase, phaseIndex) => {
    const phaseResult = args.phaseResults[phaseIndex];
    if (phaseResult !== undefined) {
      return phaseResult.progress;
    }
    return buildPhaseProgress({
      phaseId: phase.phaseId,
      status: 'pending',
      workItems: phase.workItems,
      waves: [],
    });
  });
}

function buildPhaseProgress(args: {
  phaseId: string;
  status: AgentWorkflowPhaseProgressStatus;
  workItems: readonly AgentWaveWorkItem[];
  waves: readonly AgentWorkflowWaveAttempt[];
}): AgentWorkflowPhaseProgress {
  const launchedItemIds = new Set<string>();
  const completedItemIds = new Set<string>();
  for (const wave of args.waves) {
    if (!wave.launch.ok) {
      continue;
    }
    for (const itemId of wave.selectedItemIds) {
      launchedItemIds.add(itemId);
    }
    for (const itemId of wave.launch.completedItemIds) {
      completedItemIds.add(itemId);
    }
  }

  const latestWave = args.waves.at(-1);
  const capacityReasonCode = latestWave?.decision.capacityReason.reasonCode;
  return {
    phaseId: args.phaseId,
    status: args.status,
    waveAttemptCount: args.waves.length,
    launchedItemCount: launchedItemIds.size,
    completedItemCount: completedItemIds.size,
    waitingItemCount: Math.max(0, args.workItems.length - launchedItemIds.size),
    totalItemCount: args.workItems.length,
    capacitySource: mapCapacitySource(capacityReasonCode),
    ...(capacityReasonCode !== undefined ? { capacityReasonCode } : {}),
  };
}

function mapCapacitySource(
  reasonCode: AgentWaveCapacityReasonCode | undefined,
): AgentWorkflowCapacitySource {
  switch (reasonCode) {
    case 'explicit_user_policy':
    case 'explicit_runtime_policy':
      return 'explicit_policy';
    case 'fresh_resource_snapshot':
      return 'observed_resources';
    case 'telemetry_adjusted':
      return 'telemetry';
    case 'serial_safety_floor':
      return 'serial_safety_floor';
    case 'admission_downshift':
      return 'admission_downshift';
    case undefined:
      return 'unknown';
    default: {
      const _exhaustive: never = reasonCode;
      throw new Error(`unhandled capacity reason: ${_exhaustive}`);
    }
  }
}

function buildPhaseTelemetry(
  waves: readonly AgentWorkflowWaveAttempt[],
): AgentWorkflowPhaseTelemetry {
  let serialSafetyFloorAttempts = 0;
  let widenedAttempts = 0;
  let admissionDownshiftAttempts = 0;

  for (const wave of waves) {
    switch (wave.decision.capacityReason.reasonCode) {
      case 'serial_safety_floor':
        serialSafetyFloorAttempts += 1;
        break;
      case 'admission_downshift':
        admissionDownshiftAttempts += 1;
        break;
      case 'explicit_user_policy':
      case 'explicit_runtime_policy':
      case 'fresh_resource_snapshot':
      case 'telemetry_adjusted':
        widenedAttempts += 1;
        break;
      default: {
        const _exhaustive: never = wave.decision.capacityReason.reasonCode;
        throw new Error(`unhandled capacity reason: ${_exhaustive}`);
      }
    }
  }

  return {
    recordedWaveAttempts: waves.length,
    serialSafetyFloorAttempts,
    widenedAttempts,
    admissionDownshiftAttempts,
  };
}
