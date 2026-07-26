import type { AgentLoopImplementation } from '@geulbat/agent-loop/kernel';
import { createLogger } from '@geulbat/structured-logger/logger';

import type {
  AgentChildTerminalReason,
  AgentLaunchAckToolRaw,
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
  StartSubagentBackgroundRunArgs,
  SubagentRunLauncher,
} from '../daemon-runtime-contract.js';
import { getErrorMessage } from '../utils/error.js';
import { withActivityScope } from '../utils/activity-scope.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
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
  'list_files',
  'read_file',
  'read_tool_output',
  'search_files',
] as const;

const EXPLORER_DIRECT_TOOL_NAMES = [
  ...EXPLORER_READ_TOOL_NAMES,
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
] as const;

const EXPLORER_PTC_DIRECT_TOOL_NAMES = [
  ...EXPLORER_READ_TOOL_NAMES,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
] as const;

const WORKER_DIRECT_TOOL_NAMES = [
  'list_files',
  'read_file',
  'read_tool_output',
  'search_files',
  'write_file',
  'apply_patch',
  'manage_files',
  ...AGENT_ORCHESTRATION_TOOL_NAMES,
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
  durableLaunchRecorded?: true;
}

function buildChildLaunchAck(args: {
  childRunId: string;
  childThreadId: string;
  subagentType: SubagentType;
  modelPin: ResolvedChildModelPin;
}): AgentLaunchAckToolRaw {
  return {
    ok: true,
    childRunId: args.childRunId,
    childThreadId: args.childThreadId,
    subagentType: args.subagentType,
    launchState: 'started',
    modelId: args.modelPin.modelId,
    reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
    selectionSource: args.modelPin.selectionSource,
  };
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
    ...(args.durableLaunchRecorded === true
      ? { durableLaunchRecorded: true }
      : {}),
  });
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

  const lifecycle = beginBackgroundChildLifecycle({
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
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(durableLaunchRecorded === true ? { durableLaunchRecorded: true } : {}),
  });

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
    buildChildLaunchAck({
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
    const result = await runAgentLoop({
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
    });

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
    lifecycle.publishTerminalOutcome(terminalOutcome);
  }
}
