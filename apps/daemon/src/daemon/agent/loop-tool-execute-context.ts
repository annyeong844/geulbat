import { executeTool } from '../tools/executor.js';
import {
  buildAgentToolExecutionContext,
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
    }),
    { toolRegistry: runtime.toolRegistry },
  );
}

interface BuildToolExecutionContextArgs {
  callId: string;
  approvalGranted: boolean;
  runtime: AgentToolCallRuntimeBase;
}

function buildToolExecutionContext(args: BuildToolExecutionContextArgs) {
  const { callId, approvalGranted, runtime } = args;
  return buildAgentToolExecutionContext({
    base: runtime.executionContextBase,
    callId,
    approvalGranted,
  });
}
