import { getErrorMessage } from '@geulbat/shared-utils/error';
import type { FunctionCall, HistoryItem } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import { resolveApprovalClass } from '../tools/approval-runtime-policy.js';
import { toolError } from '../tools/result.js';
import type { CallbackToolDispatcher, ExecuteResult } from '../tools/types.js';
import { createMergedAbortSignal } from '../utils/abort.js';
import type { ToolCallArgs } from './events.js';
import type { StepResult } from './loop-shared.js';
import type { AgentToolCallExecutionRuntime } from './loop-tool-runtime.js';
import { recordToolCall, recordToolResult } from './loop-tool-support.js';
import type { ToolCallSource } from './tool-call-source.js';

type SourceAwareDispatchFunction = (args: {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  source: ToolCallSource;
  denialMode: 'code_visible';
}) => Promise<StepResult<ExecuteResult>>;

export function createCallbackToolDispatcher(args: {
  runtime: AgentToolCallExecutionRuntime;
  history: HistoryItem[];
  parentRound: number;
  parentToolCallId: string;
  dispatchFunctionCall: SourceAwareDispatchFunction;
}): CallbackToolDispatcher {
  const {
    runtime,
    history,
    parentRound,
    parentToolCallId,
    dispatchFunctionCall,
  } = args;
  const base = runtime.executionContextBase;
  const runContext: RunContext = {
    stateRoot: base.stateRoot,
    workingDirectory: base.workingDirectory,
    threadId: base.threadId,
  };
  const runId = base.runId;
  let nestedCallCounter = 0;

  return {
    async dispatch({
      toolName,
      args: toolArgs,
      runtimeToolCallId,
      cellId,
      signal,
    }) {
      nestedCallCounter += 1;
      const hostCallId = `${parentToolCallId}::nested-${nestedCallCounter}`;
      const meta = runtime.toolRegistry.getToolMeta(toolName);
      const mayMutateComputerFiles = meta?.mayMutateComputerFiles === true;
      const source: ToolCallSource = {
        kind: 'ptc_callback',
        parentToolCallId,
        runtimeToolCallId,
        hostCallId,
        ...(cellId !== undefined ? { cellId } : {}),
        ...(mayMutateComputerFiles
          ? { approvalClass: resolveApprovalClass(toolName, toolArgs) }
          : {}),
      };
      const functionCall: FunctionCall = {
        id: hostCallId,
        callId: hostCallId,
        name: toolName,
        arguments: JSON.stringify(toolArgs),
      };
      const merged = createMergedAbortSignal(base.signal, signal);
      const nestedRuntime: AgentToolCallExecutionRuntime = {
        ...runtime,
        executionContextBase: {
          ...base,
          signal: merged.signal,
          runSignal: base.runSignal ?? base.signal,
        },
      };

      try {
        await recordToolCall({
          functionCall,
          round: parentRound,
          toolArgs,
          runContext,
          emit: runtime.emit,
          source,
          historyMode: 'audit_only',
        });

        let result: ExecuteResult;
        try {
          const step = await dispatchFunctionCall({
            functionCall,
            round: parentRound,
            toolArgs,
            history,
            runtime: nestedRuntime,
            source,
            denialMode: 'code_visible',
          });
          result = step.ok
            ? step.value
            : toolError(
                'execution_failed',
                'nested tool dispatch did not produce a code-visible result',
              );
        } catch (error) {
          await recordToolResult({
            functionCall,
            round: parentRound,
            toolResult: toolError('execution_failed', getErrorMessage(error)),
            computerFilesMayHaveChanged: false,
            runContext,
            runId,
            history,
            emit: runtime.emit,
            source,
            historyMode: 'audit_only',
          });
          throw error;
        }

        await recordToolResult({
          functionCall,
          round: parentRound,
          toolResult: result,
          computerFilesMayHaveChanged:
            mayMutateComputerFiles && result.ok === true,
          runContext,
          runId,
          history,
          emit: runtime.emit,
          source,
          historyMode: 'audit_only',
        });
        return result;
      } finally {
        merged.cleanup();
      }
    },
  };
}
