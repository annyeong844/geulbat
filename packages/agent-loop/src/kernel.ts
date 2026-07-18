export interface AgentLoopKernelResult {
  ok: boolean;
}

export interface AgentLoopRoundContext {
  round: number;
  sawFirstModelRequest: boolean;
}

export type AgentLoopTerminalSource =
  | 'aborted'
  | 'model_failure'
  | 'structured_output_failure'
  | 'structured_output'
  | 'structured_output_unhandled'
  | 'natural'
  | 'tool_failure';

export type AgentLoopKernelEvent =
  | {
      kind: 'round_started';
      round: number;
      historyItemCount: number;
      sawFirstModelRequest: boolean;
    }
  | {
      kind: 'round_completed';
      round: number;
      outcome: 'continue' | 'terminal';
      terminalOk?: boolean;
    };

export type AgentLoopStepResult<TResult, TValue> =
  | { ok: true; value: TValue }
  | { ok: false; result: TResult };

export interface AgentLoopModelRoundValue<
  TResult,
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
> {
  assistantText: string;
  terminalResult: TResult;
  functionCalls: readonly TFunctionCall[];
  itemsToAppend?: readonly THistoryItem[];
  structuredOutputs?: readonly TStructuredOutput[];
}

export type AgentLoopStructuredOutputResult<TResult> =
  | { ok: true; handled: false }
  | { ok: true; handled: true; result: TResult }
  | { ok: false; message: string };

export type AgentLoopTerminalCandidateDecision =
  | { kind: 'terminal' }
  | { kind: 'continue'; historyText?: string };

export type AgentLoopKernelFailure =
  | { kind: 'aborted'; message: string }
  | { kind: 'structured_output_failure'; message: string }
  | { kind: 'structured_output_unhandled'; message: string };

export interface AgentLoopKernelPorts<
  TResult extends AgentLoopKernelResult,
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
> {
  getHistoryItemCount(): number;
  beforeModelRound?(context: AgentLoopRoundContext): Promise<void>;
  runModelRound(
    context: AgentLoopRoundContext,
  ): Promise<
    AgentLoopStepResult<
      TResult,
      AgentLoopModelRoundValue<
        TResult,
        TFunctionCall,
        TStructuredOutput,
        THistoryItem
      >
    >
  >;
  processStructuredOutputs(args: {
    context: AgentLoopRoundContext;
    structuredOutputs: readonly TStructuredOutput[];
    functionCalls: readonly TFunctionCall[];
  }): Promise<AgentLoopStructuredOutputResult<TResult>>;
  appendAssistantText(args: {
    text: string;
    functionCalls: readonly TFunctionCall[];
  }): void;
  appendHistoryItems(items: readonly THistoryItem[]): void;
  appendFunctionCalls(functionCalls: readonly TFunctionCall[]): void;
  processFunctionCalls(args: {
    context: AgentLoopRoundContext;
    functionCalls: readonly TFunctionCall[];
  }): Promise<AgentLoopStepResult<TResult, void>>;
  resolveTerminalCandidate?(args: {
    context: AgentLoopRoundContext;
    source: 'structured_output' | 'natural';
    result: TResult;
  }): AgentLoopTerminalCandidateDecision;
  createTerminalFailure(failure: AgentLoopKernelFailure): TResult;
  settleTerminal(args: {
    result: TResult;
    source: AgentLoopTerminalSource;
  }): void;
  observe?(event: AgentLoopKernelEvent): void;
}

export interface RunAgentLoopKernelArgs<
  TResult extends AgentLoopKernelResult,
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
> {
  signal?: AbortSignal;
  ports: AgentLoopKernelPorts<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >;
}

type AgentLoopRoundOutcome<TResult> =
  | { kind: 'continue' }
  | {
      kind: 'terminal';
      result: TResult;
      source: AgentLoopTerminalSource;
    };

export async function runAgentLoopKernel<
  TResult extends AgentLoopKernelResult,
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
>(
  args: RunAgentLoopKernelArgs<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >,
): Promise<TResult> {
  const { ports, signal } = args;

  const finish = (
    result: TResult,
    source: AgentLoopTerminalSource,
  ): AgentLoopRoundOutcome<TResult> => {
    ports.settleTerminal({ result, source });
    return { kind: 'terminal', result, source };
  };

  const runRound = async (
    context: AgentLoopRoundContext,
  ): Promise<AgentLoopRoundOutcome<TResult>> => {
    if (signal?.aborted) {
      return finish(
        ports.createTerminalFailure({
          kind: 'aborted',
          message: 'run cancelled',
        }),
        'aborted',
      );
    }

    await ports.beforeModelRound?.(context);

    const modelRound = await ports.runModelRound(context);
    if (!modelRound.ok) {
      return finish(modelRound.result, 'model_failure');
    }

    const {
      assistantText,
      terminalResult,
      functionCalls,
      itemsToAppend,
      structuredOutputs = [],
    } = modelRound.value;
    if (itemsToAppend !== undefined) {
      ports.appendHistoryItems(itemsToAppend);
    }
    const structuredResult = await ports.processStructuredOutputs({
      context,
      structuredOutputs,
      functionCalls,
    });

    if (!structuredResult.ok) {
      return finish(
        ports.createTerminalFailure({
          kind: 'structured_output_failure',
          message: structuredResult.message,
        }),
        'structured_output_failure',
      );
    }

    if (structuredResult.handled) {
      const decision = ports.resolveTerminalCandidate?.({
        context,
        source: 'structured_output',
        result: structuredResult.result,
      });
      if (decision?.kind === 'continue') {
        if (decision.historyText !== undefined) {
          ports.appendAssistantText({
            text: decision.historyText,
            functionCalls: [],
          });
        }
        return { kind: 'continue' };
      }
      return finish(structuredResult.result, 'structured_output');
    }

    if (structuredOutputs.length > 0) {
      return finish(
        ports.createTerminalFailure({
          kind: 'structured_output_unhandled',
          message:
            'structured_output_unhandled: structured output port did not handle structured outputs',
        }),
        'structured_output_unhandled',
      );
    }

    if (itemsToAppend === undefined) {
      ports.appendAssistantText({
        text: assistantText,
        functionCalls,
      });
    }

    if (functionCalls.length === 0) {
      const decision = ports.resolveTerminalCandidate?.({
        context,
        source: 'natural',
        result: terminalResult,
      });
      if (decision?.kind === 'continue') {
        return { kind: 'continue' };
      }
      return finish(terminalResult, 'natural');
    }

    if (itemsToAppend === undefined) {
      ports.appendFunctionCalls(functionCalls);
    }
    const toolProcessing = await ports.processFunctionCalls({
      context,
      functionCalls,
    });
    if (!toolProcessing.ok) {
      return finish(toolProcessing.result, 'tool_failure');
    }
    return { kind: 'continue' };
  };

  let round = 0;
  let sawFirstModelRequest = false;
  while (true) {
    const context = { round, sawFirstModelRequest };
    ports.observe?.({
      kind: 'round_started',
      round,
      historyItemCount: ports.getHistoryItemCount(),
      sawFirstModelRequest,
    });
    const outcome = await runRound(context);
    ports.observe?.({
      kind: 'round_completed',
      round,
      outcome: outcome.kind,
      ...(outcome.kind === 'terminal' ? { terminalOk: outcome.result.ok } : {}),
    });
    if (outcome.kind === 'terminal') {
      return outcome.result;
    }
    sawFirstModelRequest = true;
    round += 1;
  }
}
