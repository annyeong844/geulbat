interface AgentLoopKernelResult {
  ok: boolean;
}

export const AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION = '1';

export interface AgentLoopImplementationIdentity {
  readonly implementationId: string;
  readonly contractVersion: string;
}

interface AgentLoopRoundContext {
  round: number;
  sawFirstModelRequest: boolean;
}

export const AGENT_LOOP_TERMINAL_SOURCES = [
  'aborted',
  'blocked',
  'model_failure',
  'no_progress',
  'structured_output_failure',
  'structured_output',
  'structured_output_unhandled',
  'natural',
  'tool_completion',
  'tool_failure',
  'verification_unavailable',
] as const;

export type AgentLoopTerminalSource =
  (typeof AGENT_LOOP_TERMINAL_SOURCES)[number];

export type AgentLoopKernelEvent =
  | {
      kind: 'round_started';
      round: number;
      historyItemCount: number;
      sawFirstModelRequest: boolean;
    }
  | {
      kind: 'model_call_started';
      round: number;
    }
  | {
      kind: 'model_call_completed';
      round: number;
      outcome: 'failure';
    }
  | {
      kind: 'model_call_completed';
      round: number;
      outcome: 'success';
      functionCallCount: number;
      structuredOutputCount: number;
    }
  | {
      kind: 'structured_outputs_started';
      round: number;
      structuredOutputCount: number;
    }
  | {
      kind: 'structured_outputs_completed';
      round: number;
      outcome: 'none' | 'handled' | 'unhandled' | 'failure';
    }
  | {
      kind: 'tool_calls_started';
      round: number;
      functionCallCount: number;
    }
  | {
      kind: 'tool_calls_completed';
      round: number;
      outcome: 'success' | 'failure';
    }
  | {
      kind: 'round_completed';
      round: number;
      outcome: 'continue';
    }
  | {
      kind: 'round_completed';
      round: number;
      outcome: 'terminal';
      terminalOk: boolean;
      terminalSource: AgentLoopTerminalSource;
    };

type AgentLoopStepResult<TResult, TValue> =
  | { ok: true; value: TValue }
  | { ok: false; result: TResult };

interface AgentLoopModelRoundValue<
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

type AgentLoopStructuredOutputResult<TResult> =
  | { ok: true; handled: false }
  | { ok: true; handled: true; result: TResult }
  | { ok: false; message: string };

export type AgentLoopTerminalCandidateDecision =
  | { kind: 'terminal' }
  | { kind: 'continue'; historyText?: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'no_progress'; message: string }
  | { kind: 'verification_unavailable'; message: string };

export type AgentLoopKernelFailure =
  | { kind: 'aborted'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'no_progress'; message: string }
  | { kind: 'structured_output_failure'; message: string }
  | { kind: 'structured_output_unhandled'; message: string }
  | { kind: 'verification_unavailable'; message: string };

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
  shouldEndTurnAfterFunctionCalls?(args: {
    context: AgentLoopRoundContext;
    functionCalls: readonly TFunctionCall[];
  }): boolean;
  resolveTerminalCandidate?(args: {
    context: AgentLoopRoundContext;
    source: 'structured_output' | 'natural' | 'tool_completion';
    result: TResult;
  }):
    | AgentLoopTerminalCandidateDecision
    | Promise<AgentLoopTerminalCandidateDecision>;
  createTerminalFailure(failure: AgentLoopKernelFailure): TResult;
  settleTerminal(args: {
    result: TResult;
    source: AgentLoopTerminalSource;
  }): void;
  checkpointEvent?(event: AgentLoopKernelEvent): Promise<void>;
  observe?(event: AgentLoopKernelEvent): void;
}

export interface AgentLoopKernelInput<
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

export interface AgentLoopImplementation extends AgentLoopImplementationIdentity {
  run<
    TResult extends AgentLoopKernelResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem,
  >(
    input: AgentLoopKernelInput<
      TResult,
      TFunctionCall,
      TStructuredOutput,
      THistoryItem
    >,
  ): Promise<TResult>;
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
  args: AgentLoopKernelInput<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >,
): Promise<TResult> {
  const { ports, signal } = args;

  const emitEvent = async (event: AgentLoopKernelEvent): Promise<void> => {
    await ports.checkpointEvent?.(event);
    ports.observe?.(event);
  };

  const finish = (
    result: TResult,
    source: AgentLoopTerminalSource,
  ): AgentLoopRoundOutcome<TResult> => {
    return { kind: 'terminal', result, source };
  };

  const assessTerminalCandidate = async (args: {
    context: AgentLoopRoundContext;
    source: 'structured_output' | 'natural' | 'tool_completion';
    result: TResult;
  }): Promise<AgentLoopRoundOutcome<TResult>> => {
    const decision = await ports.resolveTerminalCandidate?.(args);
    if (decision === undefined || decision.kind === 'terminal') {
      return finish(args.result, args.source);
    }
    if (decision.kind === 'continue') {
      if (decision.historyText !== undefined) {
        ports.appendAssistantText({
          text: decision.historyText,
          functionCalls: [],
        });
      }
      return { kind: 'continue' };
    }
    return finish(
      ports.createTerminalFailure({
        kind: decision.kind,
        message: decision.message,
      }),
      decision.kind,
    );
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

    await emitEvent({ kind: 'model_call_started', round: context.round });
    const modelRound = await ports.runModelRound(context);
    if (!modelRound.ok) {
      await emitEvent({
        kind: 'model_call_completed',
        round: context.round,
        outcome: 'failure',
      });
      return finish(modelRound.result, 'model_failure');
    }

    const {
      assistantText,
      terminalResult,
      functionCalls,
      itemsToAppend,
      structuredOutputs = [],
    } = modelRound.value;
    await emitEvent({
      kind: 'model_call_completed',
      round: context.round,
      outcome: 'success',
      functionCallCount: functionCalls.length,
      structuredOutputCount: structuredOutputs.length,
    });
    if (itemsToAppend !== undefined) {
      ports.appendHistoryItems(itemsToAppend);
    }
    await emitEvent({
      kind: 'structured_outputs_started',
      round: context.round,
      structuredOutputCount: structuredOutputs.length,
    });
    const structuredResult = await ports.processStructuredOutputs({
      context,
      structuredOutputs,
      functionCalls,
    });
    await emitEvent({
      kind: 'structured_outputs_completed',
      round: context.round,
      outcome: !structuredResult.ok
        ? 'failure'
        : structuredResult.handled
          ? 'handled'
          : structuredOutputs.length > 0
            ? 'unhandled'
            : 'none',
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
      return await assessTerminalCandidate({
        context,
        source: 'structured_output',
        result: structuredResult.result,
      });
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
      return await assessTerminalCandidate({
        context,
        source: 'natural',
        result: terminalResult,
      });
    }

    if (itemsToAppend === undefined) {
      ports.appendFunctionCalls(functionCalls);
    }
    await emitEvent({
      kind: 'tool_calls_started',
      round: context.round,
      functionCallCount: functionCalls.length,
    });
    const toolProcessing = await ports.processFunctionCalls({
      context,
      functionCalls,
    });
    await emitEvent({
      kind: 'tool_calls_completed',
      round: context.round,
      outcome: toolProcessing.ok ? 'success' : 'failure',
    });
    if (!toolProcessing.ok) {
      return finish(toolProcessing.result, 'tool_failure');
    }
    if (
      ports.shouldEndTurnAfterFunctionCalls?.({ context, functionCalls }) ===
      true
    ) {
      return await assessTerminalCandidate({
        context,
        source: 'tool_completion',
        result: terminalResult,
      });
    }
    return { kind: 'continue' };
  };

  let round = 0;
  let sawFirstModelRequest = false;
  while (true) {
    const context = { round, sawFirstModelRequest };
    await emitEvent({
      kind: 'round_started',
      round,
      historyItemCount: ports.getHistoryItemCount(),
      sawFirstModelRequest,
    });
    const outcome = await runRound(context);
    await emitEvent(
      outcome.kind === 'terminal'
        ? {
            kind: 'round_completed',
            round,
            outcome: 'terminal',
            terminalOk: outcome.result.ok,
            terminalSource: outcome.source,
          }
        : { kind: 'round_completed', round, outcome: 'continue' },
    );
    if (outcome.kind === 'terminal') {
      ports.settleTerminal({ result: outcome.result, source: outcome.source });
      return outcome.result;
    }
    sawFirstModelRequest = true;
    round += 1;
  }
}

export const agentLoopKernelImplementation: AgentLoopImplementation =
  Object.freeze({
    implementationId: 'geulbat.agent-loop.kernel',
    contractVersion: AGENT_LOOP_IMPLEMENTATION_CONTRACT_VERSION,
    run: runAgentLoopKernel,
  });
