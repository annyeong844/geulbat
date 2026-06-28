import type {
  AgentLaunchAckToolRaw,
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
import {
  createRunWorkspaceContext,
  type RunWorkspaceContext,
} from '../run-workspace-context.js';
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

const logger = createLogger('agent/subagent-support');

const DEFAULT_CHILD_PERMISSION_MODE: PermissionMode = 'basic';

const AGENT_ORCHESTRATION_TOOL_NAMES = [
  'agent_spawn',
  'agent_wait',
  'agent_send_input',
  'agent_stop',
] as const;

const SUBAGENT_TOOL_SETS = {
  explorer: [
    'list_files',
    'read_file',
    'search_files',
    ...AGENT_ORCHESTRATION_TOOL_NAMES,
  ],
  worker: [
    'list_files',
    'read_file',
    'search_files',
    'write_file',
    'patch_file',
    'manage_files',
    ...AGENT_ORCHESTRATION_TOOL_NAMES,
  ],
} as const satisfies Record<SubagentType, readonly string[]>;

interface LaunchSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: RunWorkspaceContext['threadId'];
  projectId: RunWorkspaceContext['projectId'];
  workspaceRoot: string;
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  approvalSessionId?: string;
  permissionMode?: PermissionMode;
  emitAgentEvent?: (event: AgentEvent) => void;
  runAgentLoop: (input: AgentInput) => Promise<AgentResult>;
  timeoutMs?: number;
}

function buildChildLaunchAck(args: {
  childRunId: string;
  childThreadId: string;
  subagentType: SubagentType;
}): AgentLaunchAckToolRaw {
  return {
    ok: true,
    childRunId: args.childRunId,
    childThreadId: args.childThreadId,
    subagentType: args.subagentType,
    launchState: 'started',
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
  const startedChildRun = runtime.startManagedRun(
    {
      ...(args.childRunId !== undefined ? { runId: args.childRunId } : {}),
      runContext: {
        ...(args.childThreadId !== undefined
          ? { threadId: args.childThreadId }
          : {}),
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
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
    projectId: args.projectId,
    workspaceRoot: args.workspaceRoot,
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
    ...(args.approvalSessionId !== undefined
      ? { approvalSessionId: args.approvalSessionId }
      : {}),
    ...(args.permissionMode !== undefined
      ? { permissionMode: args.permissionMode }
      : {}),
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
    projectId,
    workspaceRoot,
    startedChildRun,
    parentRunState,
    runtimeServices,
    launchReservation,
    approvalSessionId,
    permissionMode,
    emitAgentEvent,
    runAgentLoop,
    timeoutMs,
  } = args;
  const {
    runId: childRunId,
    threadId: childThreadId,
    finish,
  } = startedChildRun;

  try {
    await appendChildUserTranscriptEntry({
      workspaceRoot,
      threadId: childThreadId,
      prompt: task,
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
    emitAgentEvent,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  void runBackgroundChild({
    task,
    subagentType,
    parentRunId,
    ownerThreadId,
    projectId,
    workspaceRoot,
    approvalSessionId,
    permissionMode,
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
    }),
  );
}

async function persistChildAssistantTranscript(args: {
  workspaceRoot: string;
  childThreadId: RunWorkspaceContext['threadId'];
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
      workspaceRoot: args.workspaceRoot,
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
  ownerThreadId: RunWorkspaceContext['threadId'];
  projectId: RunWorkspaceContext['projectId'];
  workspaceRoot: string;
  approvalSessionId: string | undefined;
  permissionMode: PermissionMode | undefined;
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
    projectId,
    workspaceRoot,
    approvalSessionId,
    permissionMode,
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
      runContext: createRunWorkspaceContext({
        threadId: childThreadId,
        projectId,
        workspaceRoot,
      }),
      prompt: task,
      signal: childRunState.abortController.signal,
      runState: childRunState,
      allowedToolNames: [...SUBAGENT_TOOL_SETS[subagentType]],
      runtimeServices,
      approvalContext: {
        sessionId: approvalSessionId ?? childThreadId,
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
      workspaceRoot,
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
