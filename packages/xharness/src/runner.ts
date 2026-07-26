import {
  agentLoopKernelImplementation,
  type AgentLoopImplementation,
  type AgentLoopKernelEvent,
  type AgentLoopKernelPorts,
} from '@geulbat/agent-loop/kernel';

import type { HarnessConfigSnapshot } from './harness-snapshot.js';
import {
  compareHarnessRunTraces,
  type HarnessRunTraceComparison,
} from './run-trace-comparison.js';
import { createHarnessRunTrace, type HarnessRunTrace } from './run-trace.js';

export interface XHarnessRunArgs<
  TResult extends { ok: boolean },
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
> {
  harnessSnapshot: HarnessConfigSnapshot;
  traceIdentity: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly modelConfigId: string;
  };
  loopImplementation?: AgentLoopImplementation;
  signal?: AbortSignal;
  ports: AgentLoopKernelPorts<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >;
}

export interface XHarnessRunResult<TResult> {
  result: TResult;
  trace: HarnessRunTrace;
}

export interface XHarnessComparisonArgs<
  TResult extends { ok: boolean },
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
> {
  readonly baseline: XHarnessRunArgs<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >;
  readonly candidate: XHarnessRunArgs<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >;
}

export interface XHarnessComparisonResult<TResult> {
  readonly baseline: XHarnessRunResult<TResult>;
  readonly candidate: XHarnessRunResult<TResult>;
  readonly traceComparison: HarnessRunTraceComparison;
}

export async function runXHarness<
  TResult extends { ok: boolean },
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
>(
  args: XHarnessRunArgs<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >,
): Promise<XHarnessRunResult<TResult>> {
  const events: AgentLoopKernelEvent[] = [];
  const sourcePorts = args.ports;
  const ports: AgentLoopKernelPorts<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  > = {
    ...sourcePorts,
    observe(event) {
      events.push(event);
      sourcePorts.observe?.(event);
    },
  };
  const loopImplementation =
    args.loopImplementation ?? agentLoopKernelImplementation;
  const result = await loopImplementation.run({
    ports,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });

  return {
    result,
    trace: createHarnessRunTrace({
      ...args.traceIdentity,
      harnessSnapshotId: args.harnessSnapshot.harnessSnapshotId,
      loopImplementation,
      events,
      outcomeOk: result.ok,
    }),
  };
}

export async function runXHarnessComparison<
  TResult extends { ok: boolean },
  TFunctionCall,
  TStructuredOutput,
  THistoryItem,
>(
  args: XHarnessComparisonArgs<
    TResult,
    TFunctionCall,
    TStructuredOutput,
    THistoryItem
  >,
): Promise<XHarnessComparisonResult<TResult>> {
  const baseline = await runXHarness(args.baseline);
  const candidate = await runXHarness(args.candidate);
  return Object.freeze({
    baseline,
    candidate,
    traceComparison: compareHarnessRunTraces(baseline.trace, candidate.trace),
  });
}
