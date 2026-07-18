import {
  CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
  buildPromptCacheProjection,
  type ProviderVisiblePrefixMaterial,
  type PromptCacheProjection,
} from './provider-cache-projection.js';
import type { ProviderRequestOptions } from './provider-options.js';
import type { WireRequestBase, WireToolDefinition } from './wire/types.js';

const BETA_HEADER = process.env.GEULBAT_BETA_HEADER ?? 'responses=experimental';
const ORIGINATOR_HEADER = process.env.GEULBAT_ORIGINATOR ?? 'codex_cli_rs';

// CallModelInput의 프롬프트 표면 부분집합 — 스트리밍과 네이티브 컴팩션이
// 같은 요청 조립을 공유하기 위한 구조적 계약이다.
interface ProviderPromptInput {
  systemPrompt: string;
  promptContext?: string;
  tools?: WireToolDefinition[];
  providerSessionId: string;
  providerRequestOptions: ProviderRequestOptions;
}

type CodexDirectPromptCacheProjection = PromptCacheProjection & {
  wire: PromptCacheProjection['wire'] & {
    session_id: string;
    prompt_cache_key: string;
  };
};

export function buildResponsesRequestBody(
  input: ProviderPromptInput,
  promptCacheProjection: CodexDirectPromptCacheProjection,
): WireRequestBase {
  const requestOptions = input.providerRequestOptions;
  const instructions = buildProviderInstructions(input);
  const body: WireRequestBase = {
    model: requestOptions.model,
    store: false,
    stream: true,
    text: requestOptions.text,
    include: ['reasoning.encrypted_content'],
    ...(promptCacheProjection.wire.prompt_cache_key !== undefined
      ? { prompt_cache_key: promptCacheProjection.wire.prompt_cache_key }
      : {}),
    reasoning: requestOptions.reasoning,
    ...(instructions !== undefined ? { instructions } : {}),
  };

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

export function buildProviderInstructions(
  input: ProviderPromptInput,
): string | undefined {
  const parts: string[] = [];
  for (const part of [input.systemPrompt, input.promptContext]) {
    const trimmed = part?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function buildProviderVisiblePrefixMaterial(
  input: ProviderPromptInput,
): ProviderVisiblePrefixMaterial {
  const instructions = buildProviderInstructions(input);
  return {
    ...(instructions !== undefined ? { instructions } : {}),
    ...(input.tools !== undefined && input.tools.length > 0
      ? { tools: input.tools }
      : {}),
  };
}

export function buildCodexDirectPromptCacheProjection(
  input: ProviderPromptInput,
): CodexDirectPromptCacheProjection {
  const projection = buildPromptCacheProjection({
    profile: CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: input.providerSessionId,
      cacheGroupingIdentity: input.providerSessionId,
    },
    providerId: 'openai_codex_direct',
    routeFamily: 'openai_codex_responses',
    modelId: input.providerRequestOptions.model,
    includeSessionId: true,
    prefixMaterial: buildProviderVisiblePrefixMaterial(input),
  });
  if (projection.wire.prompt_cache_key === undefined) {
    throw new Error('Codex direct prompt cache projection is missing key');
  }
  if (projection.wire.session_id === undefined) {
    throw new Error('Codex direct prompt cache projection is missing session');
  }
  return {
    ...projection,
    wire: {
      ...projection.wire,
      session_id: projection.wire.session_id,
      prompt_cache_key: projection.wire.prompt_cache_key,
    },
  };
}

// media/image 어댑터도 같은 Codex 요청 헤더 조립을 재사용한다(이중화 금지).
export function buildResponsesRequestHeaders(args: {
  accessToken: string;
  accountId: string;
  providerSessionId: string;
}): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${args.accessToken}`);
  headers.set('chatgpt-account-id', args.accountId);
  headers.set('OpenAI-Beta', BETA_HEADER);
  headers.set('originator', ORIGINATOR_HEADER);
  headers.set('Content-Type', 'application/json');
  headers.set('accept', 'text/event-stream');
  headers.set('session_id', args.providerSessionId);
  return headers;
}
