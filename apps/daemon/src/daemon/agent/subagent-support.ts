import type { AgentLoopImplementation } from '@geulbat/agent-loop/kernel';
import { createLogger } from '@geulbat/structured-logger/logger';

import type {
  AgentChildTerminalReason,
  ResolvedChildModelPin,
  SubagentCapability,
  SubagentLaunchReservation,
  SubagentType,
} from '../subagent-runtime-contracts.js';
import {
  isAgentRunId as isRunId,
  type PermissionMode,
  type RunId,
} from './contract.js';
import type { ToolRunState, AgentEvent } from '../runtime-contracts.js';
import type { AgentResult } from './agent-result.js';
import type { AgentInput } from './loop-types.js';
import type { RunSubagentModelRouting } from './contract.js';
import { loadExistingHistory } from './loop-history.js';
import { recoverPendingReplaySafeToolCalls } from './loop-tool-recovery.js';
import { startManagedRun } from './runtime/managed-run.js';
import { runAgentLoop as runDefaultAgentLoop } from './run-agent-loop.js';
import {
  buildChildErrorTerminalOutcome,
  buildChildResultTerminalOutcome,
  type ChildTerminalOutcome,
} from './subagent-terminal-outcome.js';
import {
  beginBackgroundChildLifecycle,
  type BackgroundChildLifecycle,
  type StartedChildRunHandle,
} from './subagent-lifecycle.js';
import {
  appendChildAssistantTranscriptEntry,
  appendChildUserTranscriptEntry,
} from './subagent-transcript.js';
import { routeChildAgentEvent } from './subagent-event-routing.js';
import { createRunContext, type RunContext } from '../run-context.js';
import type {
  AgentRuntimeServices,
  RecoverSubagentBackgroundRunArgs,
  StartSubagentBackgroundRunArgs,
  SubagentRunLauncher,
} from '../daemon-runtime-contract.js';
import type { RunCheckpoint } from '../sessions/run-checkpoint-store.js';
import { getErrorMessage } from '../utils/error.js';
import { withActivityScope } from '../utils/activity-scope.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  buildChildLaunchStarted,
  resolveSubagentToolSurfaceProfile,
} from '../subagent-runtime-contracts.js';
import {
  composeAgentLoopUserPrompt,
  createAgentLoopPromptPort,
} from './loop-prompt.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import {
  createAgentLoopImplementationAdmission,
  type AgentLoopImplementationAdmission,
} from './loop-implementation-admission.js';
import { createAgentToolCapabilityPolicy } from './loop-tool-library-projection.js';
import { runDetached } from '../utils/run-detached.js';

const logger = createLogger('agent/subagent-support');

const DEFAULT_CHILD_PERMISSION_MODE: PermissionMode = 'basic';

const AGENT_ORCHESTRATION_TOOL_NAMES = [
  'agent_spawn',
  'agent_wait',
  'agent_stop',
  'agent_set_priority',
  'agent_retry',
] as const;

const EXPLORER_READ_TOOL_NAMES = [
  'inspect_git',
  'list_files',
  'read_file',
  'read_tool_output',
  'search_files',
] as const;

const EXPLORER_DIRECT_TOOL_NAMES = [
  ...EXPLORER_READ_TOOL_NAMES,
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
  'submit_result_report',
] as const;

const EXPLORER_PTC_DIRECT_TOOL_NAMES = [
  ...EXPLORER_READ_TOOL_NAMES,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
  'submit_result_report',
] as const;

const WORKER_DIRECT_TOOL_NAMES = [
  'inspect_git',
  'list_files',
  'read_file',
  'read_tool_output',
  'search_files',
  'write_file',
  'apply_patch',
  'manage_files',
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
  'submit_result_report',
] as const;

function resolveSubagentToolSurface(args: {
  ultraReasoning: boolean;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
}): {
  directRegistryNames: readonly string[];
  allowedRegistryNames: readonly string[];
} {
  const profile = resolveSubagentToolSurfaceProfile(args);
  const profileRegistryNames =
    profile === 'worker'
      ? WORKER_DIRECT_TOOL_NAMES
      : profile === 'explorer_ptc'
        ? EXPLORER_PTC_DIRECT_TOOL_NAMES
        : EXPLORER_DIRECT_TOOL_NAMES;
  const directRegistryNames = args.ultraReasoning
    ? profileRegistryNames
    : profileRegistryNames.filter((name) => name !== 'agent_spawn');
  return {
    directRegistryNames,
    allowedRegistryNames: directRegistryNames,
  };
}

interface LaunchSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  stateRoot: string;
  workingDirectory: string;
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  computerSessionId: string;
  permissionMode?: PermissionMode;
  ultraReasoning: boolean;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent?: (event: AgentEvent) => void;
  runAgentLoop: (input: AgentInput) => Promise<AgentResult>;
  loopImplementation: AgentLoopImplementation;
  toolSurface: NonNullable<AgentInput['toolSurface']>;
  toolCapabilityPolicy?: AgentInput['toolCapabilityPolicy'];
  timeoutMs?: number;
  childInputPersistence?: {
    entryId: string;
    timestamp: string;
  };
  durableLaunchRecorded?: true;
}

type StartManagedRunFn = typeof startManagedRun;
type RunAgentLoopFn = typeof runDefaultAgentLoop;

export function createSubagentRunLauncher(
  options: {
    startManagedRun?: StartManagedRunFn;
    runAgentLoop?: RunAgentLoopFn;
    loopImplementationAdmission?: AgentLoopImplementationAdmission;
  } = {},
): SubagentRunLauncher {
  const managedRunStarter = options.startManagedRun ?? startManagedRun;
  const agentLoop = options.runAgentLoop ?? runDefaultAgentLoop;
  const loopImplementationAdmission =
    options.loopImplementationAdmission ??
    createAgentLoopImplementationAdmission();
  return {
    startBackgroundRun(args) {
      return startSubagentBackgroundRun(args, {
        startManagedRun: managedRunStarter,
        runAgentLoop: agentLoop,
        loopImplementationAdmission,
      });
    },
    recoverBackgroundRun(args) {
      return recoverSubagentBackgroundRun(args, {
        startManagedRun: managedRunStarter,
        runAgentLoop: agentLoop,
        loopImplementationAdmission,
      });
    },
  };
}

async function startSubagentBackgroundRun(
  args: StartSubagentBackgroundRunArgs,
  runtime: {
    startManagedRun: StartManagedRunFn;
    runAgentLoop: RunAgentLoopFn;
    loopImplementationAdmission: AgentLoopImplementationAdmission;
  },
): Promise<{
  ok: true;
  output: string;
}> {
  if (args.computerSessionId === undefined) {
    args.launchReservation?.release();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: 'execution_failed',
        error: 'computer session is unavailable for the child run',
      }),
    );
  }

  const ultraReasoning = args.ultraReasoning ?? false;
  const startedChildRun = runtime.startManagedRun(
    {
      ...(args.childRunId !== undefined ? { runId: args.childRunId } : {}),
      runContext: {
        ...(args.childThreadId !== undefined
          ? { threadId: args.childThreadId }
          : {}),
        stateRoot: args.stateRoot,
        workingDirectory: args.workingDirectory,
      },
      ownerThreadId: args.ownerThreadId,
      parentRunId: args.parentRunId,
    },
    { activeRuns: args.runtimeServices.activeRuns },
  );

  if (!startedChildRun.ok) {
    args.launchReservation?.release();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: 'execution_failed',
        error: `child thread already active: ${startedChildRun.threadId}`,
      }),
    );
  }

  const childRunId = assertManagedRunId(startedChildRun.runId);
  const toolSurface = resolveSubagentToolSurface({
    ultraReasoning,
    subagentType: args.subagentType,
    capabilities: args.capabilities,
  });
  const requestedToolCapabilityPolicy = createAgentToolCapabilityPolicy({
    registry: args.runtimeServices.toolRegistry,
    toolSurface,
  });
  let admittedLoopImplementation;
  try {
    admittedLoopImplementation =
      await runtime.loopImplementationAdmission.admitRun({
        runId: childRunId,
        threadId: startedChildRun.threadId,
        stateRoot: args.stateRoot,
        modelConfiguration: {
          providerId:
            args.modelPin.providerRunSelection.providerModel.providerId,
          model: args.modelPin.providerRunSelection.providerModel.model,
          reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
          ...(args.modelPin.providerRunSelection.serviceTier === undefined
            ? {}
            : {
                serviceTier: args.modelPin.providerRunSelection.serviceTier,
              }),
        },
        toolCapabilityPolicy: requestedToolCapabilityPolicy,
      });
  } catch (error: unknown) {
    args.launchReservation?.release();
    startedChildRun.finish();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: 'execution_failed',
        error: `agent loop admission failed: ${getErrorMessage(error)}`,
      }),
    );
  }
  if (!admittedLoopImplementation.ok) {
    args.launchReservation?.release();
    startedChildRun.finish();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: 'execution_failed',
        error: admittedLoopImplementation.message,
      }),
    );
  }

  return await launchSubagentBackgroundRun({
    task: args.task,
    subagentType: args.subagentType,
    capabilities: args.capabilities,
    parentRunId: args.parentRunId,
    ownerThreadId: args.ownerThreadId,
    stateRoot: args.stateRoot,
    workingDirectory: args.workingDirectory,
    startedChildRun: {
      runId: childRunId,
      threadId: startedChildRun.threadId,
      runState: startedChildRun.runState,
      finish: startedChildRun.finish,
    },
    parentRunState: args.parentRunState,
    runtimeServices: args.runtimeServices,
    ...(args.launchReservation !== undefined
      ? { launchReservation: args.launchReservation }
      : {}),
    computerSessionId: args.computerSessionId,
    ...(args.permissionMode !== undefined
      ? { permissionMode: args.permissionMode }
      : {}),
    ultraReasoning,
    modelPin: args.modelPin,
    subagentModelRouting: args.subagentModelRouting,
    ...(args.emitAgentEvent !== undefined
      ? { emitAgentEvent: args.emitAgentEvent }
      : {}),
    runAgentLoop: runtime.runAgentLoop,
    loopImplementation: admittedLoopImplementation.implementation,
    toolSurface,
    ...(admittedLoopImplementation.toolCapabilityPolicy === undefined
      ? {}
      : {
          toolCapabilityPolicy: admittedLoopImplementation.toolCapabilityPolicy,
        }),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.childInputPersistence === undefined
      ? {}
      : { childInputPersistence: args.childInputPersistence }),
    ...(args.durableLaunchRecorded === true
      ? { durableLaunchRecorded: true }
      : {}),
  });
}

async function recoverSubagentBackgroundRun(
  args: RecoverSubagentBackgroundRunArgs,
  runtime: {
    startManagedRun: StartManagedRunFn;
    runAgentLoop: RunAgentLoopFn;
    loopImplementationAdmission: AgentLoopImplementationAdmission;
  },
): Promise<{
  runState: ToolRunState;
  completion: Promise<void>;
} | null> {
  const { checkpoint, launchInput, parentRunState, runtimeServices } = args;
  const backgroundChild = checkpoint.request.backgroundChild;
  if (backgroundChild === undefined) {
    return null;
  }
  const startedChildRun = runtime.startManagedRun(
    {
      runId: checkpoint.runId,
      runContext: {
        threadId: checkpoint.threadId,
        stateRoot: launchInput.stateRoot,
        workingDirectory: checkpoint.request.workingDirectory,
      },
      ownerThreadId: backgroundChild.ownerThreadId,
      parentRunId: backgroundChild.parentRunId,
    },
    { activeRuns: runtimeServices.activeRuns },
  );
  if (!startedChildRun.ok) {
    args.launchReservation.release();
    return null;
  }

  const requestedToolCapabilityPolicy =
    checkpoint.request.toolCapabilityPolicy ??
    createAgentToolCapabilityPolicy({
      registry: runtimeServices.toolRegistry,
      ...(checkpoint.request.toolSurface === undefined
        ? {}
        : { toolSurface: checkpoint.request.toolSurface }),
    });
  let admittedLoopImplementation;
  try {
    admittedLoopImplementation =
      await runtime.loopImplementationAdmission.admitRun({
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
        stateRoot: launchInput.stateRoot,
        ...(checkpoint.request.loopImplementation === undefined
          ? {}
          : { requiredIdentity: checkpoint.request.loopImplementation }),
        modelConfiguration: {
          providerId:
            launchInput.modelPin.providerRunSelection.providerModel.providerId,
          model: launchInput.modelPin.providerRunSelection.providerModel.model,
          reasoningEffort:
            launchInput.modelPin.providerRunSelection.reasoningEffort,
          ...(launchInput.modelPin.providerRunSelection.serviceTier ===
          undefined
            ? {}
            : {
                serviceTier:
                  launchInput.modelPin.providerRunSelection.serviceTier,
              }),
        },
        toolCapabilityPolicy: requestedToolCapabilityPolicy,
      });
  } catch (error: unknown) {
    args.launchReservation.release();
    startedChildRun.finish();
    logger.error('recovered child loop admission failed:', {
      childRunId: checkpoint.runId,
      cause: getErrorMessage(error),
    });
    return null;
  }
  if (!admittedLoopImplementation.ok) {
    args.launchReservation.release();
    startedChildRun.finish();
    return null;
  }

  const toolSurface =
    checkpoint.request.toolSurface ??
    resolveSubagentToolSurface({
      ultraReasoning: checkpoint.request.ultraReasoning ?? false,
      subagentType: launchInput.subagentType,
      capabilities: launchInput.capabilities,
    });
  let lifecycle: BackgroundChildLifecycle;
  try {
    lifecycle = beginBackgroundChildLifecycle({
      subagentType: launchInput.subagentType,
      capabilities: launchInput.capabilities,
      parentRunId: backgroundChild.parentRunId,
      ownerThreadId: backgroundChild.ownerThreadId,
      startedChildRun: {
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
        runState: startedChildRun.runState,
        finish: startedChildRun.finish,
      },
      parentRunState,
      runtimeServices,
      launchReservation: args.launchReservation,
      modelPin: launchInput.modelPin,
      subagentModelRouting: launchInput.subagentModelRouting,
      emitAgentEvent: undefined,
      ...(backgroundChild.timeoutAt === undefined
        ? {}
        : { timeoutAt: backgroundChild.timeoutAt }),
      durableLaunchRecorded: true,
      recoveringDurableLaunch: true,
    });
  } catch (error: unknown) {
    logger.error('recovered child lifecycle registration failed:', {
      childRunId: checkpoint.runId,
      cause: getErrorMessage(error),
    });
    return null;
  }

  const completion = withActivityScope(
    { runId: checkpoint.runId, threadId: checkpoint.threadId },
    () =>
      runBackgroundChild({
        task: '',
        subagentType: launchInput.subagentType,
        capabilities: launchInput.capabilities,
        parentRunId: backgroundChild.parentRunId,
        ownerThreadId: backgroundChild.ownerThreadId,
        stateRoot: launchInput.stateRoot,
        workingDirectory: checkpoint.request.workingDirectory,
        computerSessionId: backgroundChild.computerSessionId,
        permissionMode: checkpoint.request.permissionMode,
        ultraReasoning: checkpoint.request.ultraReasoning ?? false,
        modelPin: launchInput.modelPin,
        subagentModelRouting: launchInput.subagentModelRouting,
        emitAgentEvent: undefined,
        runAgentLoop: runtime.runAgentLoop,
        loopImplementation: admittedLoopImplementation.implementation,
        toolSurface,
        ...(admittedLoopImplementation.toolCapabilityPolicy === undefined
          ? checkpoint.request.toolCapabilityPolicy === undefined
            ? {}
            : {
                toolCapabilityPolicy: checkpoint.request.toolCapabilityPolicy,
              }
          : {
              toolCapabilityPolicy:
                admittedLoopImplementation.toolCapabilityPolicy,
            }),
        runtimeServices,
        lifecycle,
        recoveryCheckpoint: checkpoint,
      }),
  );
  return { runState: startedChildRun.runState, completion };
}

function assertManagedRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error(`invalid runId: ${value}`);
  }
  return value;
}

async function launchSubagentBackgroundRun(
  args: LaunchSubagentBackgroundRunArgs,
): Promise<{
  ok: true;
  output: string;
}> {
  const {
    task,
    subagentType,
    capabilities,
    parentRunId,
    ownerThreadId,
    stateRoot,
    workingDirectory,
    startedChildRun,
    parentRunState,
    runtimeServices,
    launchReservation,
    computerSessionId,
    permissionMode,
    ultraReasoning,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    runAgentLoop,
    loopImplementation,
    toolSurface,
    toolCapabilityPolicy,
    timeoutMs,
    childInputPersistence,
    durableLaunchRecorded,
  } = args;
  const {
    runId: childRunId,
    threadId: childThreadId,
    finish,
  } = startedChildRun;
  const { promptContext } = createAgentLoopPromptPort().buildPromptBundle({
    threadId: childThreadId,
  });
  const modelPrompt = composeAgentLoopUserPrompt({
    prompt: task,
    promptContext,
  });

  try {
    await appendChildUserTranscriptEntry({
      workspaceRoot: stateRoot,
      threadId: childThreadId,
      prompt: task,
      modelPrompt,
      ...(childInputPersistence === undefined
        ? {}
        : {
            entryId: childInputPersistence.entryId,
            timestamp: childInputPersistence.timestamp,
          }),
    });
  } catch (error: unknown) {
    launchReservation?.release();
    finish();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType,
        errorCode: 'execution_failed',
        error: `child transcript persistence failed: ${getErrorMessage(error)}`,
      }),
    );
  }

  const timeoutAt =
    timeoutMs === undefined
      ? undefined
      : new Date(Date.now() + timeoutMs).toISOString();
  const checkpointStart = await runtimeServices.runCheckpoints.startRun({
    runId: childRunId,
    threadId: childThreadId,
    request: {
      workingDirectory,
      permissionMode: permissionMode ?? DEFAULT_CHILD_PERMISSION_MODE,
      ultraReasoning,
      loopImplementation: {
        implementationId: loopImplementation.implementationId,
        contractVersion: loopImplementation.contractVersion,
      },
      providerModel: modelPin.providerRunSelection.providerModel,
      reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
      ...(modelPin.providerRunSelection.serviceTier === undefined
        ? {}
        : { serviceTier: modelPin.providerRunSelection.serviceTier }),
      subagentModelRouting,
      ...(toolCapabilityPolicy === undefined
        ? {
            toolSurface: {
              directRegistryNames: [...toolSurface.directRegistryNames],
              allowedRegistryNames: [...toolSurface.allowedRegistryNames],
            },
          }
        : { toolCapabilityPolicy }),
      backgroundChild: {
        parentRunId,
        ownerThreadId,
        computerSessionId,
        ...(timeoutAt === undefined ? {} : { timeoutAt }),
      },
    },
  });
  if (!checkpointStart.ok) {
    launchReservation?.release();
    finish();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType,
        errorCode: 'execution_failed',
        error: `child thread has recoverable run ${checkpointStart.activeRunId}`,
      }),
    );
  }

  let lifecycle: BackgroundChildLifecycle;
  try {
    lifecycle = beginBackgroundChildLifecycle({
      subagentType,
      capabilities,
      parentRunId,
      ownerThreadId,
      startedChildRun,
      parentRunState,
      runtimeServices,
      launchReservation,
      modelPin,
      subagentModelRouting,
      emitAgentEvent,
      ...(timeoutAt === undefined ? {} : { timeoutAt }),
      ...(durableLaunchRecorded === true
        ? { durableLaunchRecorded: true }
        : {}),
    });
  } catch (error: unknown) {
    await settleBackgroundChildCheckpoint({
      runtimeServices,
      childRunId,
      childThreadId,
      outcome: {
        terminalState: 'failed',
        terminalReason: 'child_error',
        terminalResult: 'sub-agent launch failed',
      },
    });
    throw error;
  }

  // 배경 자식은 호출자에서 분리되어 돈다. 그 안에서 죽음이 올라오면 소유자는
  // 부모 run이 아니라 이 자식이므로, 스코프를 분리 지점에서 연다.
  runDetached('agent/background-child', () =>
    withActivityScope({ runId: childRunId, threadId: childThreadId }, () =>
      runBackgroundChild({
        task: modelPrompt,
        subagentType,
        capabilities,
        parentRunId,
        ownerThreadId,
        stateRoot,
        workingDirectory,
        computerSessionId,
        permissionMode,
        ultraReasoning,
        modelPin,
        subagentModelRouting,
        emitAgentEvent,
        runAgentLoop,
        loopImplementation,
        toolSurface,
        ...(toolCapabilityPolicy === undefined ? {} : { toolCapabilityPolicy }),
        runtimeServices,
        lifecycle,
      }),
    ),
  );

  return buildChildLaunchPayload(
    buildChildLaunchStarted({
      childRunId,
      childThreadId,
      subagentType,
      modelPin,
    }),
  );
}

async function persistChildAssistantTranscript(args: {
  stateRoot: string;
  childThreadId: RunContext['threadId'];
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
  result: AgentResult;
}): Promise<void> {
  if (!args.result.finalProse.trim()) {
    return;
  }

  try {
    await appendChildAssistantTranscriptEntry({
      workspaceRoot: args.stateRoot,
      threadId: args.childThreadId,
      childRunId: args.childRunId,
      content: args.result.finalProse,
    });
  } catch (error: unknown) {
    logger.error('child assistant transcript persistence failed:', {
      parentRunId: args.parentRunId,
      childRunId: args.childRunId,
      childThreadId: args.childThreadId,
      subagentType: args.subagentType,
      cause: getErrorMessage(error),
    });
  }
}

async function runBackgroundChild(args: {
  task: string;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  stateRoot: string;
  workingDirectory: string;
  computerSessionId: string;
  permissionMode: PermissionMode | undefined;
  ultraReasoning: boolean;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent: ((event: AgentEvent) => void) | undefined;
  runAgentLoop: (input: AgentInput) => Promise<AgentResult>;
  loopImplementation: AgentLoopImplementation;
  toolSurface: NonNullable<AgentInput['toolSurface']>;
  toolCapabilityPolicy?: AgentInput['toolCapabilityPolicy'];
  runtimeServices: AgentRuntimeServices;
  lifecycle: BackgroundChildLifecycle;
  recoveryCheckpoint?: RunCheckpoint;
}): Promise<void> {
  const {
    task,
    subagentType,
    capabilities,
    parentRunId,
    ownerThreadId,
    stateRoot,
    workingDirectory,
    computerSessionId,
    permissionMode,
    ultraReasoning,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    runAgentLoop,
    loopImplementation,
    toolSurface,
    toolCapabilityPolicy,
    runtimeServices,
    lifecycle,
    recoveryCheckpoint,
  } = args;
  const { childRunId, childThreadId, childRunState } = lifecycle;
  let terminalMessage = '';
  let terminalReason: AgentChildTerminalReason | null = null;
  let terminalOutcome: ChildTerminalOutcome = {
    terminalState: 'failed',
    terminalReason: null,
    terminalResult: 'sub-agent failed',
  };

  try {
    const agentInput: AgentInput = {
      runId: childRunId,
      runContext: createRunContext({
        threadId: childThreadId,
        stateRoot,
        workingDirectory,
      }),
      prompt: task,
      signal: childRunState.abortController.signal,
      runState: childRunState,
      ...(toolCapabilityPolicy === undefined
        ? { toolSurface }
        : { toolCapabilityPolicy }),
      promptProfile: subagentType,
      loopImplementation,
      providerModel: modelPin.providerRunSelection.providerModel,
      ultraReasoning,
      reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
      ...(modelPin.providerRunSelection.serviceTier === undefined
        ? {}
        : { serviceTier: modelPin.providerRunSelection.serviceTier }),
      subagentModelRouting,
      runtimeServices,
      approvalContext: {
        computerSessionId,
        permissionMode: permissionMode ?? DEFAULT_CHILD_PERMISSION_MODE,
        ...(subagentType === 'worker'
          ? { ownerRunId: parentRunId, ownerThreadId }
          : {}),
      },
      onEvent: (event) => {
        const message = routeChildAgentEvent({
          event,
          parentRunId,
          childRunId,
          childThreadId,
          subagentType,
          capabilities,
          childRuns: runtimeServices.childRuns,
          ...(runtimeServices.subagent.launchRequests === undefined
            ? {}
            : {
                subagentLaunchRequests: runtimeServices.subagent.launchRequests,
              }),
          ...(emitAgentEvent !== undefined ? { emitAgentEvent } : {}),
        });
        if (message !== undefined) {
          terminalMessage = message.message;
          terminalReason = message.reason;
        }
      },
    };
    let loopInput = agentInput;
    if (recoveryCheckpoint !== undefined) {
      const recovered = await recoverPendingReplaySafeToolCalls({ agentInput });
      loopInput = {
        ...agentInput,
        prompt: recovered.modelPrompt,
        historyPort: {
          async loadInitialHistory(historyArgs) {
            return await loadExistingHistory(
              historyArgs.workspaceRoot,
              historyArgs.threadId,
              historyArgs.providerTarget,
            );
          },
        },
      };
    }
    const result = await runAgentLoop(loopInput);

    terminalOutcome = buildChildResultTerminalOutcome({
      abortSignal: childRunState.abortController.signal,
      isTimedOut: lifecycle.isTimedOut(),
      result,
      terminalMessage,
      terminalReason,
    });
    await persistChildAssistantTranscript({
      stateRoot,
      childThreadId,
      parentRunId,
      childRunId,
      subagentType,
      result,
    });
  } catch (error: unknown) {
    const childAbortSignal = childRunState.abortController.signal;
    if (!childAbortSignal.aborted) {
      logger.error('subagent runAgentLoop failed:', {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
        cause: getErrorMessage(error),
      });
    }
    terminalOutcome = buildChildErrorTerminalOutcome({
      abortSignal: childAbortSignal,
      isTimedOut: lifecycle.isTimedOut(),
      terminalMessage,
      terminalReason,
    });
  } finally {
    let published = lifecycle.publishTerminalOutcome(
      childRunState.subagentResultReportSummary === undefined
        ? terminalOutcome
        : {
            ...terminalOutcome,
            resultReportSummary: childRunState.subagentResultReportSummary,
          },
    );
    if (
      !published &&
      runtimeServices.subagent.terminalDeliveries !== undefined
    ) {
      await Promise.resolve();
      try {
        const durableOutcome =
          runtimeServices.subagent.terminalDeliveries.readSubagentTerminalOutcomeByChildRunId(
            childRunId,
          );
        published = durableOutcome !== undefined;
        if (published) {
          runtimeServices.childRuns.claimTerminalChildRuns({
            ownerThreadId,
            childRunIds: [childRunId],
          });
        }
      } catch (error: unknown) {
        logger.error(
          'retried child terminal publication reconciliation failed:',
          {
            childRunId,
            childThreadId,
            cause: getErrorMessage(error),
          },
        );
      }
    }
    if (published) {
      try {
        await settleBackgroundChildCheckpoint({
          runtimeServices,
          childRunId,
          childThreadId,
          outcome: terminalOutcome,
        });
      } catch (error: unknown) {
        logger.error('child checkpoint terminal settlement failed:', {
          childRunId,
          childThreadId,
          cause: getErrorMessage(error),
        });
      }
    }
  }
}

async function settleBackgroundChildCheckpoint(args: {
  runtimeServices: Pick<AgentRuntimeServices, 'runCheckpoints'>;
  childRunId: RunId;
  childThreadId: RunContext['threadId'];
  outcome: ChildTerminalOutcome;
}): Promise<void> {
  const terminal = await args.runtimeServices.runCheckpoints.settleRun({
    threadId: args.childThreadId,
    runId: args.childRunId,
    terminal: {
      eventCursor: 0,
      event: {
        type: 'done',
        payload: {
          answer: args.outcome.terminalResult,
          ok: args.outcome.terminalState === 'completed',
        },
      },
    },
  });
  const acknowledged =
    await args.runtimeServices.runCheckpoints.acknowledgeTerminalEvent({
      threadId: args.childThreadId,
      runId: args.childRunId,
      eventCursor: terminal.terminal?.eventCursor ?? 0,
    });
  if (!acknowledged.ok) {
    throw new Error(
      `child checkpoint terminal acknowledgement failed: ${acknowledged.code}`,
    );
  }
}
