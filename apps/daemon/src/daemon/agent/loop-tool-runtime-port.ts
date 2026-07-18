import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { FunctionCall, HistoryItem } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import type { AgentToolExecutionContextBase } from '../tools/types.js';
import type { AgentEventEmitter } from './events.js';
import type { ApprovalContext, LineSelection } from './loop-types.js';
import type { StepResult } from './loop-shared.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import type { RunState } from './runtime/run-state.js';

interface ProcessAgentLoopToolCallsArgs {
  functionCalls: FunctionCall[];
  round: number;
  history: HistoryItem[];
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
}

export interface AgentLoopToolRuntimePort {
  processFunctionCalls(
    args: ProcessAgentLoopToolCallsArgs,
  ): Promise<StepResult<void>>;
}

export function createAgentLoopToolRuntimePort(
  runtimeServices: AgentRuntimeServices,
): AgentLoopToolRuntimePort {
  return {
    async processFunctionCalls(args) {
      const executionContextBase = buildAgentToolExecutionContextBase({
        runContext: args.runContext,
        runId: args.runId,
        approvalContext: args.approvalContext,
        emit: args.emit,
        currentFile: args.currentFile,
        selection: args.selection,
        signal: args.signal,
        runState: args.runState,
        ...(args.allowedRegistryNames === undefined
          ? {}
          : { allowedRegistryNames: args.allowedRegistryNames }),
        ...(args.toolLibraryProjectionIdentity === undefined
          ? {}
          : {
              toolLibraryProjectionIdentity: args.toolLibraryProjectionIdentity,
            }),
        ...(args.providerRunSelection === undefined
          ? {}
          : { providerRunSelection: args.providerRunSelection }),
        ...(args.subagentModelRouting === undefined
          ? {}
          : { subagentModelRouting: args.subagentModelRouting }),
        ...(runtimeServices.computerFileRoot === undefined
          ? {}
          : { computerFileRoot: runtimeServices.computerFileRoot }),
        fileStateCache: runtimeServices.fileStateCache,
        memoryIndex: runtimeServices.memoryIndex,
        agentSpawnRuntime: runtimeServices,
      });
      const toolRuntime = buildToolCallExecutionRuntime({
        approvalContext: args.approvalContext,
        emit: args.emit,
        toolRegistry: runtimeServices.toolRegistry,
        approvalGate: runtimeServices.approvalGate,
        approvalGrants: runtimeServices.approvalGrants,
        executionContextBase,
      });
      return await processFunctionCalls({
        functionCalls: args.functionCalls,
        round: args.round,
        history: args.history,
        runtime: toolRuntime,
      });
    },
  };
}
