import { isRecord } from '../../../runtime-json.js';
import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import { ProviderReplayScopeMismatchError } from '../provider-error.js';
import { ProviderHistoryItemInvalidError } from '../transport/responses-wire-input.js';
import type { HistoryItem } from '../wire/types.js';
import { requireQwenNonEmpty } from './config.js';

interface QwenChatTextPart {
  type: 'text';
  text: string;
}

interface QwenChatImagePart {
  type: 'image_url';
  image_url: { url: string };
}

type QwenChatUserPart = QwenChatTextPart | QwenChatImagePart;

interface QwenChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type QwenChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | QwenChatUserPart[] }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: QwenChatToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface PendingAssistantMessage {
  content: string;
  reasoningContent: string;
  toolCalls: QwenChatToolCall[];
}

export function buildQwenChatMessages(input: {
  history: HistoryItem[];
  providerReplayScopeId?: ProviderReplayScopeId;
}): QwenChatMessage[] {
  const messages: QwenChatMessage[] = [];
  let pending = createPendingAssistantMessage();

  const flushAssistant = (): void => {
    if (
      pending.content === '' &&
      pending.reasoningContent === '' &&
      pending.toolCalls.length === 0
    ) {
      return;
    }
    messages.push({
      role: 'assistant',
      content: pending.content === '' ? null : pending.content,
      ...(pending.reasoningContent === ''
        ? {}
        : { reasoning_content: pending.reasoningContent }),
      ...(pending.toolCalls.length === 0
        ? {}
        : { tool_calls: pending.toolCalls }),
    });
    pending = createPendingAssistantMessage();
  };

  for (const item of input.history) {
    switch (item.kind) {
      case 'user':
        flushAssistant();
        messages.push({
          role: 'user',
          content: buildQwenUserContent(item),
        });
        break;
      case 'assistant':
        if (item.phase === 'commentary') {
          pending.reasoningContent += item.text;
        } else {
          pending.content += item.text;
        }
        break;
      case 'function_call':
        pending.toolCalls.push(toQwenToolCall(item));
        break;
      case 'function_call_output':
        flushAssistant();
        messages.push({
          role: 'tool',
          tool_call_id: item.callId,
          content: item.output,
        });
        break;
      case 'backend_item':
        assertQwenReplayScope(
          item.providerReplayScopeId,
          input.providerReplayScopeId,
        );
        appendQwenBackendItem(item.data, pending);
        break;
      case 'provider_native_compaction':
        throw new ProviderHistoryItemInvalidError();
    }
  }
  flushAssistant();
  return messages;
}

function createPendingAssistantMessage(): PendingAssistantMessage {
  return { content: '', reasoningContent: '', toolCalls: [] };
}

function buildQwenUserContent(
  item: Extract<HistoryItem, { kind: 'user' }>,
): string | QwenChatUserPart[] {
  if (item.attachments === undefined || item.attachments.length === 0) {
    return item.text;
  }

  const parts: QwenChatUserPart[] = [];
  if (item.text !== '') {
    parts.push({ type: 'text', text: item.text });
  }
  for (const attachment of item.attachments) {
    switch (attachment.kind) {
      case 'image':
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
          },
        });
        break;
      case 'text':
        parts.push({
          type: 'text',
          text: `Attachment ${attachment.name}:\n${attachment.text}`,
        });
        break;
      case 'pdf':
        throw new QwenUnsupportedAttachmentError(attachment.name);
    }
  }
  return parts;
}

function toQwenToolCall(
  item: Extract<HistoryItem, { kind: 'function_call' }>,
): QwenChatToolCall {
  return {
    id: requireQwenNonEmpty(item.callId, 'Qwen tool call id'),
    type: 'function',
    function: {
      name: requireQwenNonEmpty(item.name, 'Qwen tool name'),
      arguments: item.arguments,
    },
  };
}

function appendQwenBackendItem(
  value: unknown,
  pending: PendingAssistantMessage,
): void {
  if (!isRecord(value)) {
    throw new ProviderHistoryItemInvalidError();
  }
  if (value['type'] === 'message') {
    const phase = value['phase'];
    if (phase !== 'commentary' && phase !== 'final_answer') {
      throw new ProviderHistoryItemInvalidError();
    }
    const text = readQwenBackendMessageText(value['content']);
    if (phase === 'commentary') {
      pending.reasoningContent += text;
    } else {
      pending.content += text;
    }
    return;
  }
  if (value['type'] === 'function_call') {
    const id = value['id'];
    const callId = value['call_id'];
    const name = value['name'];
    const callArguments = value['arguments'];
    if (
      typeof id !== 'string' ||
      id.trim() === '' ||
      typeof callId !== 'string' ||
      callId.trim() === '' ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof callArguments !== 'string'
    ) {
      throw new ProviderHistoryItemInvalidError();
    }
    pending.toolCalls.push({
      id: callId,
      type: 'function',
      function: { name, arguments: callArguments },
    });
    return;
  }
  throw new ProviderHistoryItemInvalidError();
}

function readQwenBackendMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new ProviderHistoryItemInvalidError();
  }
  let text = '';
  for (const part of value) {
    if (
      !isRecord(part) ||
      part['type'] !== 'output_text' ||
      typeof part['text'] !== 'string'
    ) {
      throw new ProviderHistoryItemInvalidError();
    }
    text += part['text'];
  }
  return text;
}

function assertQwenReplayScope(
  itemScope: ProviderReplayScopeId | null | undefined,
  targetScope: ProviderReplayScopeId | undefined,
): void {
  if (
    targetScope !== undefined &&
    itemScope !== undefined &&
    itemScope !== targetScope
  ) {
    throw new ProviderReplayScopeMismatchError();
  }
}

class QwenUnsupportedAttachmentError extends Error {
  constructor(name: string) {
    super(`Qwen chat transport does not support PDF attachment '${name}'`);
    this.name = 'QwenUnsupportedAttachmentError';
  }
}
