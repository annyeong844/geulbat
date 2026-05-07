import type { ParsedCanonicalArtifactEnvelope } from '@geulbat/protocol/artifacts';

export type ProviderArtifactCandidate = ParsedCanonicalArtifactEnvelope;

export type HistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; phase: 'commentary' | 'final_answer'; text: string }
  | {
      kind: 'function_call';
      id: string;
      callId: string;
      name: string;
      arguments: string;
    }
  | { kind: 'function_call_output'; callId: string; output: string }
  | { kind: 'backend_item'; data: unknown };

export interface FunctionCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export interface CallResult {
  itemsToAppend: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
}

// ── Provider wire format types ──

export interface WireToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
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
