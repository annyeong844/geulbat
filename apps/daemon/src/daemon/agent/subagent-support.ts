import type {
  AgentLaunchAckToolRaw,
  ResolvedChildModelPin,
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
import { createLogger } from '@geulbat/shared-utils/logger';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
} from '../subagent-runtime-contracts.js';
import {
  composeAgentLoopUserPrompt,
  createAgentLoopPromptPort,
} from './loop-prompt.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
const logger = createLogger('agent/subagent-support');

const DEFAULT_CHILD_PERMISSION_MODE: PermissionMode = 'basic';

const AGENT_ORCHESTRATION_TOOL_NAMES = [
  'agent_spawn',
  'agent_wait',
  'agent_stop',
] as const;

const EXPLORER_DIRECT_TOOL_NAMES = [
  'list_files',
  'read_file',
  'read_tool_output',
  'search_files',
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

const SUBAGENT_TOOL_SURFACES = {
  explorer: {
    directRegistryNames: EXPLORER_DIRECT_TOOL_NAMES,
    allowedRegistryNames: EXPLORER_DIRECT_TOOL_NAMES,
  },
  worker: {
    directRegistryNames: WORKER_DIRECT_TOOL_NAMES,
    allowedRegistryNames: WORKER_DIRECT_TOOL_NAMES,
  },
} as const satisfies Record<
  SubagentType,
  {
    directRegistryNames: readonly string[];
    allowedRegistryNames: readonly string[];
  }
>;

interface LaunchSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  stateRoot: string;
  workingDirectory: string;
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  approvalSessionId: string;
  permissionMode?: PermissionMode;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent?: (event: AgentEvent) => void;
  runAgentLoop: (input: AgentInput) => Promise<AgentResult>;
  timeoutMs?: number;
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
  } = {},
): SubagentRunLauncher {
  const managedRunStarter = options.startManagedRun ?? startManagedRun;
  const agentLoop = options.runAgentLoop ?? runDefaultAgentLoop;
  return {
    startBackgroundRun(args) {
      return startSubagentBackgroundRun(args, {
        startManagedRun: managedRunStarter,
        runAgentLoop: agentLoop,
      });
    },
  };
}

async function startSubagentBackgroundRun(
  args: StartSubagentBackgroundRunArgs,
  runtime: {
    startManagedRun: StartManagedRunFn;
    runAgentLoop: RunAgentLoopFn;
  },
): Promise<{
  ok: true;
  output: string;
}> {
  if (args.approvalSessionId === undefined) {
    args.launchReservation?.release();
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: 'execution_failed',
        error: 'approval session is unavailable for the child run',
      }),
    );
  }

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

  return await launchSubagentBackgroundRun({
    task: args.task,
    subagentType: args.subagentType,
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
    approvalSessionId: args.approvalSessionId,
    ...(args.permissionMode !== undefined
      ? { permissionMode: args.permissionMode }
      : {}),
    modelPin: args.modelPin,
    subagentModelRouting: args.subagentModelRouting,
    ...(args.emitAgentEvent !== undefined
      ? { emitAgentEvent: args.emitAgentEvent }
      : {}),
    runAgentLoop: runtime.runAgentLoop,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
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
    parentRunId,
    ownerThreadId,
    stateRoot,
    workingDirectory,
    startedChildRun,
    parentRunState,
    runtimeServices,
    launchReservation,
    approvalSessionId,
    permissionMode,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    runAgentLoop,
    timeoutMs,
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
  });

  void runBackgroundChild({
    task: modelPrompt,
    subagentType,
    parentRunId,
    ownerThreadId,
    stateRoot,
    workingDirectory,
    approvalSessionId,
    permissionMode,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    runAgentLoop,
    runtimeServices,
    lifecycle,
  });

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
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  stateRoot: string;
  workingDirectory: string;
  approvalSessionId: string;
  permissionMode: PermissionMode | undefined;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent: ((event: AgentEvent) => void) | undefined;
  runAgentLoop: (input: AgentInput) => Promise<AgentResult>;
  runtimeServices: AgentRuntimeServices;
  lifecycle: BackgroundChildLifecycle;
}): Promise<void> {
  const {
    task,
    subagentType,
    parentRunId,
    ownerThreadId,
    stateRoot,
    workingDirectory,
    approvalSessionId,
    permissionMode,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    runAgentLoop,
    runtimeServices,
    lifecycle,
  } = args;
  const { childRunId, childThreadId, childRunState } = lifecycle;
  let terminalMessage = '';
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
      toolSurface: SUBAGENT_TOOL_SURFACES[subagentType],
      promptProfile: subagentType,
      providerModel: modelPin.providerRunSelection.providerModel,
      reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
      subagentModelRouting,
      runtimeServices,
      approvalContext: {
        sessionId: approvalSessionId,
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
          subagentType,
          childRuns: runtimeServices.childRuns,
          ...(emitAgentEvent !== undefined ? { emitAgentEvent } : {}),
        });
        if (message !== undefined) {
          terminalMessage = message;
        }
      },
    });

    terminalOutcome = buildChildResultTerminalOutcome({
      result,
      terminalMessage,
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
    });
  } finally {
    lifecycle.publishTerminalOutcome(terminalOutcome);
  }
}
