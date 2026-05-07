import type { HistoryItem, WireRequestBase } from '../wire/types.js';

export function buildResponseCreatePayload(
  body: WireRequestBase,
  history: HistoryItem[],
): Record<string, unknown> {
  return {
    type: 'response.create',
    ...body,
    input: toWireInput(history),
  };
}

function toWireInput(history: HistoryItem[]): unknown[] {
  const input: unknown[] = [];

  for (const item of history) {
    switch (item.kind) {
      case 'user':
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: item.text }],
        });
        break;
      case 'assistant':
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: item.text }],
          ...(item.phase ? { phase: item.phase } : {}),
        });
        break;
      case 'function_call':
        input.push({
          type: 'function_call',
          // Current history does not persist provider reasoning pairs, so omit
          // function_call.id on replay and let call_id carry continuity.
          call_id: item.callId,
          name: item.name,
          arguments: item.arguments,
        });
        break;
      case 'function_call_output':
        input.push({
          type: 'function_call_output',
          call_id: item.callId,
          output: item.output,
        });
        break;
      case 'backend_item':
        break;
    }
  }

  return input;
}
