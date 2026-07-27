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
import type { ToolResultContextBudget } from './memory/compaction-loop.js';
import { createToolOutputProjectionRound } from './tool-output-offload.js';
import type { ToolResultObservation } from './observer/agent-loop-observer.js';
import type { ToolExecutionRegistry } from '../tools/tool-registry-model.js';
import { assertAgentRunId } from './contract.js';

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
  toolRegistry: ToolExecutionRegistry;
  allowedRegistryNames?: readonly string[];
  toolCapabilityPolicy?: AgentToolExecutionContextBase['toolCapabilityPolicy'];
  toolLibraryProjectionIdentity?: AgentToolExecutionContextBase['toolLibraryProjectionIdentity'];
  providerRunSelection?: AgentToolExecutionContextBase['providerRunSelection'];
  ultraReasoning?: AgentToolExecutionContextBase['ultraReasoning'];
  subagentModelRouting?: AgentToolExecutionContextBase['subagentModelRouting'];
  planningWorkflow?: AgentToolExecutionContextBase['planningWorkflow'];
  toolResultContextBudget?: ToolResultContextBudget;
  observeToolResult?: (observation: ToolResultObservation) => void;
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
      const projectionRound =
        args.toolResultContextBudget === undefined
          ? undefined
          : createToolOutputProjectionRound({
              availableModelVisibleBytes:
                args.toolResultContextBudget.kind === 'available'
                  ? args.toolResultContextBudget.availableRequestBytes
                  : undefined,
              resultCount: args.functionCalls.length,
            });
      const runCheckpoints =
        (await runtimeServices.runCheckpoints.hasRunningRun({
          threadId: args.runContext.threadId,
          runId: assertAgentRunId(args.runId),
        }))
          ? runtimeServices.runCheckpoints
          : undefined;
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
        ...(args.toolCapabilityPolicy === undefined
          ? {}
          : { toolCapabilityPolicy: args.toolCapabilityPolicy }),
        ...(args.toolLibraryProjectionIdentity === undefined
          ? {}
          : {
              toolLibraryProjectionIdentity: args.toolLibraryProjectionIdentity,
            }),
        ...(args.providerRunSelection === undefined
          ? {}
          : { providerRunSelection: args.providerRunSelection }),
        ultraReasoning: args.ultraReasoning,
        ...(args.subagentModelRouting === undefined
          ? {}
          : { subagentModelRouting: args.subagentModelRouting }),
        ...(args.planningWorkflow === undefined
          ? {}
          : { planningWorkflow: args.planningWorkflow }),
        ...(runtimeServices.computerFileRoot === undefined
          ? {}
          : { computerFileRoot: runtimeServices.computerFileRoot }),
        fileStateCache: runtimeServices.fileStateCache,
        memoryIndex: runtimeServices.memoryIndex,
        runtimeServices,
      });
      const toolRuntime = buildToolCallExecutionRuntime({
        approvalContext: args.approvalContext,
        emit: args.emit,
        toolRegistry: args.toolRegistry,
        approvalGate: runtimeServices.approvalGate,
        approvalGrants: runtimeServices.approvalGrants,
        executionContextBase,
        ...(runCheckpoints === undefined ? {} : { runCheckpoints }),
      });
      return await processFunctionCalls({
        functionCalls: args.functionCalls,
        round: args.round,
        history: args.history,
        runtime: toolRuntime,
        ...(projectionRound === undefined ? {} : { projectionRound }),
        ...(args.observeToolResult === undefined
          ? {}
          : { observeToolResult: args.observeToolResult }),
      });
    },
  };
}
