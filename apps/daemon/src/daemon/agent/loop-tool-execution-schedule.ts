import type { FunctionCall } from '../llm/index.js';
import { PTC_EXECUTE_CODE_WAIT_TOOL_NAME } from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type {
  ExecuteResult,
  ToolResultProjectionCapability,
} from '../tools/types.js';
import type { ToolMeta, ToolMetaReader } from '../tools/tool-registry-model.js';
import type { SharedToolWindowCallKind } from './loop-tool-shared-window-admission.js';
import { parseToolCallArguments } from './loop-tool-support.js';

export interface PreparedFunctionCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  computerFilesMayHaveChanged: boolean;
  resultProjection?: ToolResultProjectionCapability;
}

export interface PreparedSharedFunctionCall extends PreparedFunctionCall {
  sharedKind: SharedToolWindowCallKind;
}

export type FunctionCallScheduleItem =
  | {
      kind: 'shared_window';
      preparedFunctionCalls: PreparedSharedFunctionCall[];
    }
  | {
      kind: 'exclusive';
      preparedFunctionCall: PreparedFunctionCall;
    }
  | {
      kind: 'invalid_args';
      functionCall: FunctionCall;
      errorResult: ExecuteResult;
      resultProjection?: ToolResultProjectionCapability;
    };

export function prepareFunctionCallSchedule(
  functionCalls: readonly FunctionCall[],
  toolMetaReader: ToolMetaReader,
): FunctionCallScheduleItem[] {
  const schedule: FunctionCallScheduleItem[] = [];
  let sharedWindow: PreparedSharedFunctionCall[] = [];
  const flushSharedWindow = () => {
    if (sharedWindow.length === 0) {
      return;
    }
    schedule.push({
      kind: 'shared_window',
      preparedFunctionCalls: sharedWindow,
    });
    sharedWindow = [];
  };

  for (const functionCall of functionCalls) {
    const toolMeta = toolMetaReader.getToolMeta(functionCall.name);
    const parsedArgs = parseToolCallArguments(functionCall.arguments);
    if (!parsedArgs.ok) {
      flushSharedWindow();
      schedule.push({
        kind: 'invalid_args',
        functionCall,
        errorResult: parsedArgs.error,
        ...(toolMeta?.resultProjection === undefined
          ? {}
          : { resultProjection: toolMeta.resultProjection }),
      });
      continue;
    }

    const sharedKind = classifySharedFunctionCallKind({
      toolMeta,
      toolName: functionCall.name,
      toolArgs: parsedArgs.args,
    });

    const preparedFunctionCall = {
      functionCall,
      toolArgs: parsedArgs.args,
      computerFilesMayHaveChanged:
        toolMeta !== null ? toolMeta.mayMutateComputerFiles : false,
      ...(toolMeta?.resultProjection === undefined
        ? {}
        : { resultProjection: toolMeta.resultProjection }),
    };

    if (sharedKind === null) {
      flushSharedWindow();
      schedule.push({
        kind: 'exclusive',
        preparedFunctionCall,
      });
      continue;
    }

    sharedWindow.push({
      ...preparedFunctionCall,
      sharedKind,
    });
  }

  flushSharedWindow();
  return schedule;
}

function classifySharedFunctionCallKind(args: {
  toolMeta: ToolMeta | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): SharedToolWindowCallKind | null {
  const { toolMeta } = args;
  if (
    toolMeta === null ||
    toolMeta.requiresApproval ||
    toolMeta.mayMutateComputerFiles
  ) {
    return null;
  }

  if (toolMeta.parallelBatchKind === 'subagent_launch') {
    return toolMeta.sideEffectLevel === 'none' ? 'subagent_launch' : null;
  }

  if (toolMeta.parallelBatchKind === 'ptc_cell') {
    return isPtcCellSharedWindowEligibleToolMeta(toolMeta) &&
      isPtcCellSharedWindowEligibleCall(args)
      ? 'ptc_cell'
      : null;
  }

  return toolMeta.sideEffectLevel === 'read' ? 'read_only' : null;
}

function isPtcCellSharedWindowEligibleToolMeta(toolMeta: ToolMeta): boolean {
  return (
    toolMeta.requiresApproval === false &&
    toolMeta.mayMutateComputerFiles === false &&
    toolMeta.sideEffectLevel === 'none' &&
    toolMeta.parallelBatchKind === 'ptc_cell'
  );
}

function isPtcCellSharedWindowEligibleCall(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
}): boolean {
  if (args.toolName !== PTC_EXECUTE_CODE_WAIT_TOOL_NAME) {
    return true;
  }

  return args.toolArgs.terminate !== true;
}
