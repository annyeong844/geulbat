import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';

import type { ResponsesRequestMeasurement } from '../daemon/llm/provider/transport/responses-websocket.js';
import type {
  AgentToolExecutionContext,
  AnyTool,
  ExecuteResult,
  ToolParseResult,
} from '../daemon/tools/types.js';

export function createTestContextBudgetRound(
  onContextUsage?: (snapshot: ContextUsageUpdatedEventPayload) => void,
) {
  let requestBytes: number | undefined;
  return {
    onProviderRequestPrepared(measurement: ResponsesRequestMeasurement) {
      requestBytes = measurement.serializedBytes;
    },
    async prepareBeforeModelRound() {
      return { kind: 'failed' as const, message: 'not requested by this test' };
    },
    getRequestBytes() {
      return requestBytes;
    },
    getToolResultContextBudget() {
      return {
        kind: 'unknown' as const,
        modelKey: 'test\0test',
        reason: 'usage_unavailable' as const,
      };
    },
    publish(snapshot: ContextUsageUpdatedEventPayload) {
      onContextUsage?.(snapshot);
    },
  };
}

export function parseObjectArgs<TArgs extends object>(
  raw: unknown,
): ToolParseResult<TArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'tool arguments must be an object.' };
  }
  return { ok: true, value: raw as TArgs };
}

export function makePathArgumentTestTool<
  TArgs extends object = Record<string, unknown>,
>(args: {
  name: string;
  description: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  requiresApproval: boolean;
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: AgentToolExecutionContext,
  ) => Promise<ExecuteResult>;
}): AnyTool {
  return {
    name: args.name,
    description: args.description,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    mayMutateComputerFiles: false,
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}
