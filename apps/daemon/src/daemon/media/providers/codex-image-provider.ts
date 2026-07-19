import { CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY } from '../../llm/provider/client.js';
import { buildResponsesRequestHeaders } from '../../llm/provider/codex-request.js';
import { streamResponsesOverWebSocket } from '../../llm/provider/transport/responses-websocket.js';
import type { ResponsesWebSocketSessionStore } from '../../llm/provider/transport/responses-websocket-cache.js';
import { isRecord } from '../../runtime-json.js';
import {
  ImageGenerationError,
  type GeneratedImageCandidate,
  type ImageGenerationRequest,
} from '../contract.js';
import { validateGeneratedImageBase64 } from '../image-candidate-validation.js';

// ChatGPT Codex Responses 백엔드의 hosted `image_generation` 툴을 데몬이 직접
// 호출하는 어댑터. 요청/응답 매핑만 소유하고, 토큰 수급/리프레시는 호출자
// (image-generation-runtime)가 provider-auth 경계로 처리한다.

// 래퍼 챗 모델 — hosted image_generation 툴을 호출하는 Responses 모델.
// 2026-07 기준 API 라인업은 gpt-5.6 패밀리(mini 없음), 효율 티어는 luna.
const DEFAULT_CODEX_IMAGE_MODEL = 'gpt-5.6-luna';

function resolveCodexImageModel(): string {
  return (
    process.env.GEULBAT_IMAGE_GENERATION_CODEX_MODEL ??
    DEFAULT_CODEX_IMAGE_MODEL
  );
}

// 하부 이미지 모델 — hosted 툴이 실제 생성에 쓸 모델. 2026-04 출시
// gpt-image-2가 API·Codex 최신. 백엔드가 tool option을 거부하면 S3 라이브
// 검증에서 명시적으로 드러난다(fail-closed).
// 우선순위(§4.1): 요청 스코프 모델(사용자 선택) > env knob > 내장 기본값
const DEFAULT_CODEX_UNDERLYING_IMAGE_MODEL = 'gpt-image-2';

// 이미지 생성은 partial/final 이벤트 간격이 챗 스트림 기본 유휴 상한(60s)을
// 넘는다(S3 라이브에서 60s 지점 절단 확정). 툴 타임아웃(5분)과 정렬한
// 관대한 기본값 + env knob.
const DEFAULT_CODEX_IMAGE_IDLE_TIMEOUT_MS = 300_000;

function resolveCodexImageIdleTimeoutMs(): number {
  const raw = process.env.GEULBAT_IMAGE_GENERATION_CODEX_IDLE_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CODEX_IMAGE_IDLE_TIMEOUT_MS;
}

function resolveCodexUnderlyingImageModel(
  requestModel: string | undefined,
): string {
  return (
    requestModel ??
    process.env.GEULBAT_IMAGE_GENERATION_CODEX_IMAGE_MODEL ??
    DEFAULT_CODEX_UNDERLYING_IMAGE_MODEL
  );
}

// 프롬프트 충실도 규약은 ima2-gen 시맨틱을 축약 이식한 것. 사용자가 쓴 언어와
// 스타일 지시를 보존하고, 임의 확장을 막는다.
const CODEX_IMAGE_DEVELOPER_PROMPT =
  'You are an image generation assistant. Your primary function is to invoke the image_generation tool. Never respond with plain text only. ' +
  "Preserve the user's prompt by default. If the prompt is visually sufficient, pass it through unchanged as the image_generation prompt argument. " +
  "When the user's request is abstract, conceptual, or non-visual, interpret it creatively and render it as an image. " +
  'Quality guidelines: default to crisp details, clean lines, well-balanced composition, appropriate contrast and color. ' +
  'Avoid blur, noise, compression artifacts, watermark, signature, cropped elements, and duplicates. ' +
  'Text and typography must be rendered with precise spelling, sharp edges, and no distortion. ' +
  'Preserve the style the user explicitly or implicitly requests; if no style is specified, produce a polished, high-quality image without imposing any stylistic bias. Do not default to photorealism unless the user asks for it.';

const CODEX_IMAGE_PROMPT_FIDELITY_SUFFIX =
  "\n\nWhen you call the image_generation tool, treat the user's prompt as the source of truth. If the prompt is already visually sufficient, pass it through unchanged as the image_generation prompt argument. Do not translate, summarize, rewrite, restyle, expand, or add descriptors unless genuinely necessary to satisfy an underspecified visual request. If the user wrote in Korean, keep the Korean text. Do not inject additional style descriptors when the user already specified a style.";

interface CodexImageProviderInput {
  request: ImageGenerationRequest;
  auth: { accessToken: string; accountId: string };
  providerSessionId: string;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket'
  >;
  signal?: AbortSignal;
  streamResponses?: typeof streamResponsesOverWebSocket;
  now?: () => string;
}

export function buildCodexImageRequestPayload(args: {
  request: ImageGenerationRequest;
  model: string;
  providerSessionId: string;
}): Record<string, unknown> {
  const { request } = args;
  const imageToolOptions: Record<string, unknown> = {
    model: resolveCodexUnderlyingImageModel(request.model),
    moderation: 'low',
    ...(request.size !== undefined ? { size: request.size } : {}),
    ...(request.quality !== undefined ? { quality: request.quality } : {}),
  };
  return {
    type: 'response.create',
    model: args.model,
    store: false,
    stream: true,
    prompt_cache_key: args.providerSessionId,
    input: [
      { role: 'developer', content: CODEX_IMAGE_DEVELOPER_PROMPT },
      {
        role: 'user',
        content: `Generate an image: ${request.prompt}${CODEX_IMAGE_PROMPT_FIDELITY_SUFFIX}`,
      },
    ],
    tools: [{ type: 'image_generation', ...imageToolOptions }],
    tool_choice: 'required',
    reasoning: { effort: 'low' },
  };
}

interface CodexImageGenerationCallItem {
  result: string;
  revisedPrompt?: string;
}

function readImageGenerationCallItem(
  data: unknown,
): CodexImageGenerationCallItem | null {
  if (!isRecord(data) || data.type !== 'image_generation_call') {
    return null;
  }
  if (typeof data.result !== 'string' || data.result.length === 0) {
    return null;
  }
  return {
    result: data.result,
    ...(typeof data.revised_prompt === 'string' && data.revised_prompt
      ? { revisedPrompt: data.revised_prompt }
      : {}),
  };
}

// 빈 결과 진단(§4.4) — 백엔드가 무엇을 돌려줬는지 오류 메시지에 남긴다.
// 비밀/base64 비노출: 페이로드는 타입·상태·길이만, 텍스트는 짧은 머리만.
function summarizeItemsForDiagnostics(
  items: readonly { kind: string; data?: unknown }[],
): string {
  if (items.length === 0) {
    return 'no items';
  }
  return items
    .slice(0, 8)
    .map((item) => {
      const data = isRecord(item.data) ? item.data : undefined;
      const type = typeof data?.type === 'string' ? data.type : '';
      const status = typeof data?.status === 'string' ? `,${data.status}` : '';
      const resultLength =
        typeof data?.result === 'string'
          ? `,result:${data.result.length}ch`
          : '';
      const text =
        typeof data?.text === 'string' && data.text.length > 0
          ? `,text:"${data.text.slice(0, 120)}"`
          : '';
      return `${item.kind}(${type}${status}${resultLength}${text})`;
    })
    .join(' | ');
}

// 이벤트 타입 시퀀스 압축 — 연속 중복은 "type×n"으로 접는다(델타 폭주 대비).
function summarizeEventTypesForDiagnostics(types: readonly string[]): string {
  const firstType = types[0];
  if (firstType === undefined) {
    return 'no events';
  }
  const parts: string[] = [];
  let current = firstType;
  let count = 1;
  for (const type of types.slice(1)) {
    if (type === current) {
      count += 1;
      continue;
    }
    parts.push(count > 1 ? `${current}×${count}` : current);
    current = type;
    count = 1;
  }
  parts.push(count > 1 ? `${current}×${count}` : current);
  return parts.slice(0, 24).join(' → ');
}

export async function generateImageViaCodexResponses(
  input: CodexImageProviderInput,
): Promise<GeneratedImageCandidate> {
  const model = resolveCodexImageModel();
  const payload = buildCodexImageRequestPayload({
    request: input.request,
    model,
    providerSessionId: input.providerSessionId,
  });
  const headers = buildResponsesRequestHeaders({
    accessToken: input.auth.accessToken,
    accountId: input.auth.accountId,
    providerSessionId: input.providerSessionId,
  });

  // 빈 결과 진단용 — 전송 계층이 sanitize한 스냅샷에서 이벤트 타입만 수집
  // (페이로드·비밀값은 이 경로로 들어오지 않는다).
  const observedEventTypes: string[] = [];
  const streamResponses = input.streamResponses ?? streamResponsesOverWebSocket;
  const result = await streamResponses({
    payload,
    headers,
    historyProjection: 'provider_output',
    providerSessionId: input.providerSessionId,
    webSocketReusePolicy: CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
    providerWebSocketSessions: input.providerWebSocketSessions,
    idleTimeoutMs: resolveCodexImageIdleTimeoutMs(),
    discoverySink: {
      recordRequest() {},
      recordEvent(snapshot) {
        if (isRecord(snapshot) && typeof snapshot.type === 'string') {
          observedEventTypes.push(snapshot.type);
        }
      },
    },
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let imageItem: CodexImageGenerationCallItem | null = null;
  for (const item of result.itemsToAppend) {
    if (item.kind !== 'backend_item') {
      continue;
    }
    imageItem = readImageGenerationCallItem(item.data);
    if (imageItem !== null) {
      break;
    }
  }

  if (imageItem === null) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'empty_image_result',
      message:
        'Codex Responses call completed without an image_generation_call result' +
        ` (received: ${summarizeItemsForDiagnostics(result.itemsToAppend)};` +
        ` events: ${summarizeEventTypesForDiagnostics(observedEventTypes)})`,
    });
  }

  const asset = validateGeneratedImageBase64({
    dataBase64: imageItem.result,
  });
  const now = input.now ?? (() => new Date().toISOString());
  return {
    asset,
    provenance: {
      providerId: 'openai_codex_direct',
      model,
      capability: 'image_generation',
      prompt: input.request.prompt,
      ...(imageItem.revisedPrompt !== undefined
        ? { revisedPrompt: imageItem.revisedPrompt }
        : {}),
      generatedAt: now(),
    },
  };
}
