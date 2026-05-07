import type { AgentToolExecutionContextBase } from '../tools/types.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import type { ToolExecutionRegistry } from '../tools/tool-registry-model.js';
import type {
  AgentMemoryIndex,
  AgentRuntimeServices,
} from '../daemon-runtime-contract.js';
import type { ApprovalGate } from './runtime/approval-gate.js';
import type { RunState } from './runtime/run-state.js';
import type { AgentEventEmitter } from './events.js';
import type { ApprovalContext, LineSelection } from './loop-types.js';

export type ApprovalTarget = {
  runId: string;
  threadId: RunWorkspaceContext['threadId'];
};

export type AgentToolCallRuntimeBase = {
  approvalContext: ApprovalContext;
  emit: AgentEventEmitter;
  toolRegistry: ToolExecutionRegistry;
  approvalGrants: AgentRuntimeServices['approvalGrants'];
  executionContextBase: AgentToolExecutionContextBase;
};

export interface AgentToolCallExecutionRuntime extends AgentToolCallRuntimeBase {
  approvalGate: Pick<ApprovalGate, 'waitForApproval'>;
}

type ExecutionContextBaseOwner = {
  executionContextBase?: AgentToolExecutionContextBase;
  runContext?: RunWorkspaceContext;
  runState?: RunState;
  signal?: AbortSignal;
  runId?: string;
  workspaceRoot?: string;
  threadId?: RunWorkspaceContext['threadId'];
};

export function buildAgentToolExecutionContextBase(args: {
  runContext: RunWorkspaceContext;
  runId: string;
  approvalContext: ApprovalContext;
  emit: AgentEventEmitter;
  currentFile: string | undefined;
  selection: LineSelection | undefined;
  signal: AbortSignal | undefined;
  runState: RunState | undefined;
  fileStateCache?: AgentRuntimeServices['fileStateCache'];
  memoryIndex: AgentMemoryIndex | undefined;
  agentSpawnRuntime: AgentRuntimeServices | undefined;
}): AgentToolExecutionContextBase {
  return {
    kind: 'agent',
    signal: args.signal,
    runSignal: args.signal,
    workspaceRoot: args.runContext.workspaceRoot,
    currentFile: args.currentFile,
    selection: args.selection,
    approvalSessionId: args.approvalContext.sessionId,
    permissionMode: args.approvalContext.permissionMode,
    threadId: args.runContext.threadId,
    runId: args.runId,
    projectId: args.runContext.projectId,
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
  executionContextBase: AgentToolExecutionContextBase;
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
): RunWorkspaceContext {
  return {
    workspaceRoot: executionContextBase.workspaceRoot,
    threadId: executionContextBase.threadId,
    projectId: executionContextBase.projectId,
  };
}

export function getToolRuntimeRunContext(
  runtime: ExecutionContextBaseOwner,
): RunWorkspaceContext {
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
  return (
    (runtime.executionContextBase?.runState as RunState | undefined) ??
    runtime.runState
  );
}

export function getToolRuntimeSignal(
  runtime: ExecutionContextBaseOwner,
): AbortSignal | undefined {
  return runtime.executionContextBase?.signal ?? runtime.signal;
}

export function getToolRuntimeWorkspaceRoot(
  runtime: ExecutionContextBaseOwner,
): string {
  const workspaceRoot =
    runtime.executionContextBase?.workspaceRoot ??
    runtime.runContext?.workspaceRoot ??
    runtime.workspaceRoot;
  if (!workspaceRoot) {
    throw new Error('tool runtime workspaceRoot is required');
  }
  return workspaceRoot;
}
