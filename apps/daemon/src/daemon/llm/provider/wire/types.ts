import type { DaemonArtifactCandidate } from '../../../artifact-candidate.js';
import type { JsonValue } from '../../../runtime-json.js';

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
      output: ProviderNativeCompactionOutputItem[];
    }
  | { kind: 'backend_item'; data: unknown };

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

export interface CallResult {
  itemsToAppend: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
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

export interface WireRequestBody {
  model: string;
  store: boolean;
  stream: boolean;
  instructions?: string;
  input: unknown[];
  include?: string[];
  prompt_cache_key?: string;
  tools?: WireToolDefinition[];
  tool_choice?: string;
  text?: { verbosity: string };
  reasoning?: { effort: string; summary: string };
}

export type WireRequestBase = Omit<WireRequestBody, 'input'>;
