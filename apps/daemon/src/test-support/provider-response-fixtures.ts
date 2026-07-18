import {
  callModelWithDependencies,
  type CallModelInput,
} from '../daemon/llm/provider/client.js';
import { parseResponseEvents } from '../daemon/llm/provider/transport/responses-parser.js';
import type { ProviderStructuredOutput } from '../daemon/llm/index.js';
import type { CallModelFn } from '../daemon/agent/loop-types.js';

type ProviderResponseEventFixture = Record<string, unknown>;

export interface ProviderRoundFixture {
  events?: ProviderResponseEventFixture[];
  error?: Error;
  structuredOutputs?: ProviderStructuredOutput[];
  inspectInput?: (input: CallModelInput) => void;
}

export function composeProviderRounds(
  ...rounds: ProviderRoundFixture[]
): ProviderRoundFixture {
  const structuredOutputs = rounds.flatMap(
    (round) => round.structuredOutputs ?? [],
  );

  return {
    events: rounds.flatMap((round) => round.events ?? []),
    ...(structuredOutputs.length > 0 ? { structuredOutputs } : {}),
    inspectInput(input) {
      for (const round of rounds) {
        round.inspectInput?.(input);
      }
    },
  };
}

export function createScriptedProviderCallModel(
  rounds: ProviderRoundFixture[],
): CallModelFn {
  let roundIndex = 0;

  return (input) => {
    const fixture = rounds[roundIndex];
    if (!fixture) {
      throw new Error(`unexpected provider round ${roundIndex + 1}`);
    }
    roundIndex += 1;
    fixture.inspectInput?.(input);

    const replayFixtureEvents = async (
      onAssistantDelta: Parameters<typeof parseResponseEvents>[1] | undefined,
      historyProjection: 'normalized' | 'provider_output',
    ) => {
      if (fixture.error) {
        throw fixture.error;
      }
      const result = await parseResponseEvents(
        toAsyncEvents(fixture.events ?? []),
        onAssistantDelta,
        { historyProjection },
      );
      return {
        ...result,
        ...(fixture.structuredOutputs !== undefined
          ? { structuredOutputs: fixture.structuredOutputs }
          : {}),
      };
    };

    return callModelWithDependencies(input, {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: ({ onAssistantDelta }) =>
        replayFixtureEvents(onAssistantDelta, 'provider_output'),
      // Grok routes through its own transport; without this stub a
      // grok-selected round would hit the real websocket endpoint.
      streamGrokOAuthResponses: (_grokInput, options) =>
        replayFixtureEvents(options.onAssistantDelta, 'normalized'),
    });
  };
}

export function providerStructuredOutputRound(
  structuredOutputs: ProviderStructuredOutput | ProviderStructuredOutput[],
): ProviderRoundFixture {
  return {
    events: [],
    structuredOutputs: Array.isArray(structuredOutputs)
      ? structuredOutputs
      : [structuredOutputs],
  };
}

export function providerFinalAnswerRound(
  text: string,
  options?: { itemId?: string },
): ProviderRoundFixture {
  const itemId = options?.itemId ?? 'msg_1';
  return {
    events: [
      {
        type: 'response.output_item.added',
        item: { id: itemId, type: 'message', phase: 'final_answer' },
      },
      {
        type: 'response.output_text.delta',
        item_id: itemId,
        delta: text,
      },
      {
        type: 'response.output_item.done',
        item: {
          id: itemId,
          type: 'message',
          phase: 'final_answer',
          content: [{ type: 'output_text', text }],
        },
      },
    ],
  };
}

export function providerToolRound(args: {
  toolName: string;
  argumentsJson?: string;
  commentaryText?: string;
  messageId?: string;
  functionCallId?: string;
  callId?: string;
}): ProviderRoundFixture {
  const messageId = args.messageId ?? 'msg_1';
  const functionCallId = args.functionCallId ?? 'fc-1';
  const callId = args.callId ?? 'call-1';
  const commentaryText = args.commentaryText ?? 'thinking...';

  return {
    events: [
      {
        type: 'response.output_item.added',
        item: { id: messageId, type: 'message', phase: 'commentary' },
      },
      {
        type: 'response.output_text.delta',
        item_id: messageId,
        delta: commentaryText,
      },
      {
        type: 'response.output_item.done',
        item: {
          id: messageId,
          type: 'message',
          phase: 'commentary',
          content: [{ type: 'output_text', text: commentaryText }],
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          id: functionCallId,
          type: 'function_call',
          call_id: callId,
          name: args.toolName,
          arguments: args.argumentsJson ?? '{"path":"dummy.txt"}',
        },
      },
    ],
  };
}

async function* toAsyncEvents(
  events: ProviderResponseEventFixture[],
): AsyncGenerator<ProviderResponseEventFixture> {
  for (const event of events) {
    yield event;
  }
}
