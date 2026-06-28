import { executeTool } from '../tools/executor.js';
import {
  buildAgentToolExecutionContext,
  type CallbackToolDispatcher,
  type ExecuteResult,
} from '../tools/types.js';
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
}

export async function executeResolvedFunctionCall(
  args: ExecuteResolvedFunctionCallArgs,
): Promise<ExecuteResult> {
  const { functionCall, toolArgs, approvalGranted, runtime } = args;

  const runState = getToolRuntimeRunState(runtime);
  if (runState) {
    markRunRunning(runState);
  }

  return executeTool(
    functionCall.name,
    toolArgs,
    buildToolExecutionContext({
      callId: functionCall.callId,
      approvalGranted,
      runtime,
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
}

function buildToolExecutionContext(args: BuildToolExecutionContextArgs) {
  const { callId, approvalGranted, runtime, callbackToolDispatcher } = args;
  const context = buildAgentToolExecutionContext({
    base: runtime.executionContextBase,
    callId,
    approvalGranted,
  });
  return callbackToolDispatcher
    ? { ...context, callbackToolDispatcher }
    : context;
}
