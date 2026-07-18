import type { AgentToolExecutionContextBase } from '../tools/types.js';
import type { RunContext } from '../run-context.js';
import type { ToolExecutionRegistry } from '../tools/tool-registry-model.js';
import type {
  AgentMemoryIndex,
  AgentRuntimeServices,
} from '../daemon-runtime-contract.js';
import type { ApprovalGate } from './runtime/approval-gate.js';
import type { RunState } from './runtime/run-state.js';
import type { AgentEventEmitter } from './events.js';
import type { ApprovalContext, LineSelection } from './loop-types.js';
import { isAgentRunId } from './contract.js';

export type ApprovalTarget = {
  runId: string;
  threadId: RunContext['threadId'];
};

type AgentLoopToolExecutionContextBase = Omit<
  AgentToolExecutionContextBase,
  'runState'
> & {
  runState: RunState | undefined;
};

export type AgentToolCallRuntimeBase = {
  approvalContext: ApprovalContext;
  emit: AgentEventEmitter;
  toolRegistry: ToolExecutionRegistry;
  approvalGrants: AgentRuntimeServices['approvalGrants'];
  executionContextBase: AgentLoopToolExecutionContextBase;
};

export interface AgentToolCallExecutionRuntime extends AgentToolCallRuntimeBase {
  approvalGate: Pick<ApprovalGate, 'waitForApproval'>;
}

type ExecutionContextBaseOwner = {
  executionContextBase?: AgentLoopToolExecutionContextBase;
  runContext?: RunContext;
  runState?: RunState;
  signal?: AbortSignal;
  runId?: string;
  threadId?: RunContext['threadId'];
};

export function buildAgentToolExecutionContextBase(args: {
  runContext: RunContext;
  runId: string;
  approvalContext: ApprovalContext;
  emit: AgentEventEmitter;
  currentFile: string | undefined;
  selection: LineSelection | undefined;
  signal: AbortSignal | undefined;
  runState: RunState | undefined;
  allowedRegistryNames?: readonly string[];
  toolLibraryProjectionIdentity?: AgentToolExecutionContextBase['toolLibraryProjectionIdentity'];
  providerRunSelection?: AgentToolExecutionContextBase['providerRunSelection'];
  subagentModelRouting?: AgentToolExecutionContextBase['subagentModelRouting'];
  computerFileRoot?: string;
  fileStateCache?: AgentRuntimeServices['fileStateCache'];
  memoryIndex: AgentMemoryIndex | undefined;
  agentSpawnRuntime: AgentRuntimeServices | undefined;
}): AgentLoopToolExecutionContextBase {
  const runOwnerKind =
    isAgentRunId(args.runId) &&
    args.agentSpawnRuntime?.childRuns.getChildRun(args.runId) !== undefined
      ? 'child'
      : 'root_main';
  return {
    kind: 'agent',
    signal: args.signal,
    runSignal: args.signal,
    stateRoot: args.runContext.stateRoot,
    workingDirectory: args.runContext.workingDirectory,
    ...(args.computerFileRoot === undefined
      ? {}
      : { computerFileRoot: args.computerFileRoot }),
    currentFile: args.currentFile,
    selection: args.selection,
    approvalSessionId: args.approvalContext.sessionId,
    ...(args.allowedRegistryNames !== undefined
      ? { allowedRegistryNames: args.allowedRegistryNames }
      : {}),
    ...(args.toolLibraryProjectionIdentity === undefined
      ? {}
      : { toolLibraryProjectionIdentity: args.toolLibraryProjectionIdentity }),
    ...(args.providerRunSelection === undefined
      ? {}
      : { providerRunSelection: args.providerRunSelection }),
    ...(args.subagentModelRouting === undefined
      ? {}
      : { subagentModelRouting: args.subagentModelRouting }),
    permissionMode: args.approvalContext.permissionMode,
    threadId: args.runContext.threadId,
    runId: args.runId,
    runOwnerKind,
    runState: args.runState,
    emitAgentEvent: (event) => args.emit(event.type, event.payload),
    ...(args.fileStateCache ? { fileStateCache: args.fileStateCache } : {}),
    memoryIndex: args.memoryIndex,
    agentSpawnRuntime: args.agentSpawnRuntime,
  };
}

export function buildToolCallExecutionRuntime(args: {
  approvalContext: ApprovalContext;
  emit: AgentEventEmitter;
  toolRegistry: ToolExecutionRegistry;
  approvalGate: Pick<ApprovalGate, 'waitForApproval'>;
  approvalGrants: AgentRuntimeServices['approvalGrants'];
  executionContextBase: AgentLoopToolExecutionContextBase;
}): AgentToolCallExecutionRuntime {
  return {
    approvalContext: args.approvalContext,
    emit: args.emit,
    toolRegistry: args.toolRegistry,
    approvalGrants: args.approvalGrants,
    executionContextBase: args.executionContextBase,
    approvalGate: args.approvalGate,
  };
}

function buildRunContextFromExecutionBase(
  executionContextBase: AgentToolExecutionContextBase,
): RunContext {
  return {
    stateRoot: executionContextBase.stateRoot,
    workingDirectory: executionContextBase.workingDirectory,
    threadId: executionContextBase.threadId,
  };
}

export function getToolRuntimeRunContext(
  runtime: ExecutionContextBaseOwner,
): RunContext {
  if (runtime.executionContextBase) {
    return buildRunContextFromExecutionBase(runtime.executionContextBase);
  }
  if (runtime.runContext) {
    return runtime.runContext;
  }
  throw new Error('tool runtime runContext is required');
}

export function getToolRuntimeRunState(
  runtime: ExecutionContextBaseOwner,
): RunState | undefined {
  return runtime.executionContextBase?.runState ?? runtime.runState;
}

export function getToolRuntimeSignal(
  runtime: ExecutionContextBaseOwner,
): AbortSignal | undefined {
  return runtime.executionContextBase?.signal ?? runtime.signal;
}

export function isToolOutputRecoveryAvailable(
  runtime: ExecutionContextBaseOwner,
): boolean {
  const allowedRegistryNames =
    runtime.executionContextBase?.allowedRegistryNames;
  return (
    allowedRegistryNames === undefined ||
    allowedRegistryNames.includes('read_tool_output')
  );
}
