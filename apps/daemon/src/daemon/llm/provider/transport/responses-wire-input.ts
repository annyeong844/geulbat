import type {
  HistoryItem,
  HistoryUserAttachment,
  WireRequestBase,
} from '../wire/types.js';
import { isRecord } from '../../../runtime-json.js';
import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import { ProviderReplayScopeMismatchError } from '../provider-replay-scope.js';

export function buildResponseCreatePayload(
  body: WireRequestBase,
  history: HistoryItem[],
  providerReplayScopeId?: ProviderReplayScopeId,
): Record<string, unknown> {
  return {
    type: 'response.create',
    ...body,
    input: buildResponseWireInput(history, {
      providerId: 'openai_codex_direct',
      model: body.model,
      ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
    }),
  };
}

interface ProviderNativeHistoryTarget {
  providerId: string;
  model: string;
  providerReplayScopeId?: ProviderReplayScopeId;
}

export function buildResponseWireInput(
  history: HistoryItem[],
  providerNativeTarget?: ProviderNativeHistoryTarget,
): unknown[] {
  assertValidFunctionCallReplay(history, providerNativeTarget);
  const input: unknown[] = [];

  for (const item of history) {
    switch (item.kind) {
      case 'user':
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: item.text },
            ...(item.attachments ?? []).flatMap(buildAttachmentContent),
          ],
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
          // Normalized fallback history has no replayable provider item or
          // reasoning pair. Codex direct rounds use backend_item instead.
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
      case 'provider_native_compaction':
        if (
          providerNativeTarget === undefined ||
          item.providerId !== providerNativeTarget.providerId ||
          item.model !== providerNativeTarget.model
        ) {
          throw new ProviderNativeHistoryIncompatibleError();
        }
        assertReplayScopeCompatible(
          item.providerReplayScopeId,
          providerNativeTarget.providerReplayScopeId,
        );
        input.push(...item.output);
        break;
      case 'backend_item':
        if (!isRecord(item.data)) {
          throw new ProviderHistoryItemInvalidError();
        }
        assertReplayScopeCompatible(
          item.providerReplayScopeId,
          providerNativeTarget?.providerReplayScopeId,
        );
        input.push(item.data);
        break;
    }
  }

  return input;
}

function assertReplayScopeCompatible(
  itemScope: ProviderReplayScopeId | null | undefined,
  targetScope: ProviderReplayScopeId | undefined,
): void {
  // Undefined is reserved for current-process normalized/test history. Every
  // persisted provider-native item is rehydrated with either its digest or
  // explicit null, so durable replay cannot bypass this comparison.
  if (
    targetScope !== undefined &&
    itemScope !== undefined &&
    itemScope !== targetScope
  ) {
    throw new ProviderReplayScopeMismatchError();
  }
}

function assertValidFunctionCallReplay(
  history: HistoryItem[],
  providerNativeTarget?: ProviderNativeHistoryTarget,
): void {
  const normalizedCallIds = new Set<string>();
  for (const item of history) {
    if (item.kind !== 'function_call') {
      continue;
    }
    if (
      providerNativeTarget !== undefined ||
      normalizedCallIds.has(item.callId)
    ) {
      throw new ProviderHistoryItemInvalidError();
    }
    normalizedCallIds.add(item.callId);
  }

  const providerCallIds = new Set<string>();
  for (const item of history) {
    if (item.kind !== 'backend_item') {
      continue;
    }
    if (!isRecord(item.data)) {
      throw new ProviderHistoryItemInvalidError();
    }
    if (item.data['type'] !== 'function_call') {
      continue;
    }

    const id = item.data['id'];
    const callId = item.data['call_id'];
    const name = item.data['name'];
    const callArguments = item.data['arguments'];
    if (
      typeof id !== 'string' ||
      id.trim() === '' ||
      typeof callId !== 'string' ||
      callId.trim() === '' ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof callArguments !== 'string' ||
      normalizedCallIds.has(callId) ||
      providerCallIds.has(callId)
    ) {
      throw new ProviderHistoryItemInvalidError();
    }
    providerCallIds.add(callId);
  }
}

export class ProviderHistoryItemInvalidError extends Error {
  readonly code = 'provider_history_item_invalid';

  constructor() {
    super('provider history item is invalid');
    this.name = 'ProviderHistoryItemInvalidError';
  }
}

class ProviderNativeHistoryIncompatibleError extends Error {
  readonly code = 'provider_native_history_incompatible';

  constructor() {
    super(
      'provider-native compaction history is incompatible with this request',
    );
    this.name = 'ProviderNativeHistoryIncompatibleError';
  }
}

// codex의 local image 규약을 따른다 — 이미지 블록 앞뒤로 이름 태그를
// 둘러서 모델이 어떤 파일인지 알 수 있게 한다.
function buildAttachmentContent(
  attachment: HistoryUserAttachment,
): Array<Record<string, unknown>> {
  if (attachment.kind === 'image') {
    return [
      { type: 'input_text', text: `<image name="${attachment.name}">` },
      {
        type: 'input_image',
        image_url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
      },
      { type: 'input_text', text: '</image>' },
    ];
  }
  if (attachment.kind === 'pdf') {
    return [
      {
        type: 'input_file',
        filename: attachment.name,
        file_data: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
      },
    ];
  }
  return [
    {
      type: 'input_text',
      text: `<file name="${attachment.name}">\n${attachment.text}\n</file>`,
    },
  ];
}
