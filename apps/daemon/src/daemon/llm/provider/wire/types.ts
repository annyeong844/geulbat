import type { DaemonArtifactCandidate } from '../../../artifact-candidate.js';
import type { JsonValue } from '../../../runtime-json.js';
import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';

export type ProviderArtifactCandidate = DaemonArtifactCandidate;
export type ProviderNativeCompactionOutputItem = Record<string, JsonValue>;

// 사용자 첨부의 모델 전달 형태 — 이미지는 input_image(data URL) 블록,
// 텍스트 파일은 본문을 담은 input_text 블록으로 나간다.
export type HistoryUserAttachment =
  | { kind: 'image'; name: string; mimeType: string; dataBase64: string }
  | { kind: 'pdf'; name: string; mimeType: string; dataBase64: string }
  | { kind: 'text'; name: string; text: string };

export type HistoryItem =
  | { kind: 'user'; text: string; attachments?: HistoryUserAttachment[] }
  | { kind: 'assistant'; phase: 'commentary' | 'final_answer'; text: string }
  | {
      kind: 'function_call';
      id: string;
      callId: string;
      name: string;
      arguments: string;
    }
  | { kind: 'function_call_output'; callId: string; output: string }
  | {
      kind: 'provider_native_compaction';
      providerId: string;
      model: string;
      providerReplayScopeId?: ProviderReplayScopeId | null;
      output: ProviderNativeCompactionOutputItem[];
    }
  | {
      kind: 'backend_item';
      data: unknown;
      providerReplayScopeId?: ProviderReplayScopeId | null;
    };

export interface FunctionCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export interface ProviderStructuredOutput {
  schemaVersion: number;
  kind: string;
  payload: unknown;
}

/**
 * Chat Completions SSE (`finish_reason`) 종료 신호.
 *
 * 우리 스택에서는 qwen_token_plan HTTP SSE 경로만 채운다. openai_codex_direct
 * / grok_oauth Responses WebSocket 은 finish_reason 이 없고 이 필드를 비운다.
 * WS 경로에 chat-completions 종료 이유를 흉내 내어 넣지 않는다.
 *
 * `tool_calls` + 실제 functionCalls 0건은 Qwen SSE에서 도구를 쓰겠다고 알리고
 * payload는 비운 불일치다. 내레이션을 최종 답으로 승격하면 안 된다.
 */
export type ModelRoundStopReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'unknown';

export interface CallResult {
  itemsToAppend: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
  stopReason?: ModelRoundStopReason;
}

interface ProviderUsageTelemetryFields {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export type ProviderUsageTelemetry =
  | (ProviderUsageTelemetryFields & { inputTokens: number })
  | (ProviderUsageTelemetryFields & { outputTokens: number })
  | (ProviderUsageTelemetryFields & { cachedInputTokens: number });

// ── Provider wire format types ──

interface WireToolObjectParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

interface WireToolOneOfParameters {
  oneOf: WireToolObjectParameters[];
}

interface WireToolAnyOfParameters {
  anyOf: WireToolObjectParameters[];
}

type WireToolParameters =
  | WireToolObjectParameters
  | WireToolOneOfParameters
  | WireToolAnyOfParameters;

export interface WireToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: WireToolParameters;
  strict: boolean;
}

interface WireDeferredToolDefinition extends WireToolDefinition {
  defer_loading: true;
}

interface WireHostedToolSearchDefinition {
  type: 'tool_search';
}

export type WireResponsesToolDefinition =
  | WireToolDefinition
  | WireDeferredToolDefinition
  | WireHostedToolSearchDefinition;

export interface WireRequestBody {
  model: string;
  service_tier?: 'default' | 'priority';
  store: boolean;
  stream: boolean;
  instructions?: string;
  input: unknown[];
  include?: string[];
  prompt_cache_key?: string;
  tools?: WireResponsesToolDefinition[];
  tool_choice?: string;
  text?: { verbosity: string };
  reasoning?: { effort: string; summary: string };
}

export type WireRequestBase = Omit<WireRequestBody, 'input'>;
