import { executeTool } from '../tools/executor.js';
import { toolError } from '../tools/result.js';
import {
  buildAgentToolExecutionContext,
  type CallbackToolDispatcher,
  type ExecuteResult,
  type ToolExecutionResourceSnapshotRef,
} from '../tools/types.js';
import { RUN_APPROVAL_PENDING_STATUS } from '../runtime-contracts.js';
import { markRunRunning } from './runtime/run-state.js';
import type { FunctionCall } from '../llm/index.js';
import type { ToolCallArgs } from './events.js';
import {
  getToolRuntimeRunState,
  type AgentToolCallRuntimeBase,
} from './loop-tool-runtime.js';

interface ExecuteResolvedFunctionCallArgs {
  functionCall: FunctionCall;
  toolArgs: ToolCallArgs;
  approvalGranted: boolean;
  runtime: AgentToolCallRuntimeBase;
  callbackToolDispatcher?: CallbackToolDispatcher;
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
}

export async function executeResolvedFunctionCall(
  args: ExecuteResolvedFunctionCallArgs,
): Promise<ExecuteResult> {
  const { functionCall, toolArgs, approvalGranted, runtime } = args;

  const runState = getToolRuntimeRunState(runtime);
  if (runState?.status === 'cancelled') {
    return toolError('aborted', 'run cancelled before tool execution');
  }
  if (runState?.status === RUN_APPROVAL_PENDING_STATUS) {
    markRunRunning(runState);
  }

  return executeTool(
    functionCall.name,
    toolArgs,
    buildToolExecutionContext({
      callId: functionCall.callId,
      approvalGranted,
      runtime,
      ...(args.resourceSnapshotRef === undefined
        ? {}
        : { resourceSnapshotRef: args.resourceSnapshotRef }),
      ...(args.callbackToolDispatcher
        ? { callbackToolDispatcher: args.callbackToolDispatcher }
        : {}),
    }),
    { toolRegistry: runtime.toolRegistry },
  );
}

interface BuildToolExecutionContextArgs {
  callId: string;
  approvalGranted: boolean;
  runtime: AgentToolCallRuntimeBase;
  callbackToolDispatcher?: CallbackToolDispatcher;
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
}

function buildToolExecutionContext(args: BuildToolExecutionContextArgs) {
  const {
    callId,
    approvalGranted,
    runtime,
    callbackToolDispatcher,
    resourceSnapshotRef,
  } = args;
  const context = buildAgentToolExecutionContext({
    base: runtime.executionContextBase,
    callId,
    approvalGranted,
    ...(resourceSnapshotRef === undefined ? {} : { resourceSnapshotRef }),
  });
  return callbackToolDispatcher
    ? { ...context, callbackToolDispatcher }
    : context;
}
