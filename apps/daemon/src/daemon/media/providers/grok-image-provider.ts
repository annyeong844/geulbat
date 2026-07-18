import { GROK_OAUTH_RESPONSES_BASE_URL } from '../../llm/provider/grok-oauth-transport.js';
import { isRecord } from '../../runtime-json.js';
import {
  ImageGenerationError,
  type GeneratedImageCandidate,
  type ImageGenerationRequest,
} from '../contract.js';
import { validateGeneratedImageBase64 } from '../image-candidate-validation.js';

// xAI 이미지 생성 API를 데몬이 직접 호출하는 어댑터(bounded HTTPS POST).
// OAuth bearer는 호출자(image-generation-runtime)가 provider-auth 경계로 수급한다.

// S0 스파이크(2026-07-12)에서 판정: 'grok-2-image'는 404(모델 소멸/미접근).
// 현행 유효 모델은 grok-imagine-image·grok-imagine-image-quality이고,
// 기본은 quality(사용자 결정 2026-07-13).
const DEFAULT_GROK_IMAGE_MODEL = 'grok-imagine-image-quality';

// 우선순위(§4.1): 요청 스코프 모델(사용자 선택) > env knob > 내장 기본값
function resolveGrokImageModel(requestModel: string | undefined): string {
  return (
    requestModel ??
    process.env.GEULBAT_IMAGE_GENERATION_GROK_MODEL ??
    DEFAULT_GROK_IMAGE_MODEL
  );
}

function resolveGrokImageGenerationsUrl(): string {
  return (
    process.env.GEULBAT_IMAGE_GENERATION_GROK_URL ??
    `${GROK_OAUTH_RESPONSES_BASE_URL}/images/generations`
  );
}

const DEFAULT_GROK_IMAGE_TIMEOUT_MS = 180_000;

function resolveGrokImageTimeoutMs(): number {
  const raw = process.env.GEULBAT_IMAGE_GENERATION_GROK_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_GROK_IMAGE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GROK_IMAGE_TIMEOUT_MS;
}

interface GrokImageProviderInput {
  request: ImageGenerationRequest;
  auth: { accessToken: string };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

interface GrokGeneratedImage {
  b64: string;
  revisedPrompt?: string;
}

// 업스트림 본문은 시크릿이 섞일 수 있는 진단-프라이빗 재료다.
// 상태코드/분류만 밖으로 내보내고 원문은 싣지 않는다.
function classifyGrokFailure(status: number): ImageGenerationError {
  if (status === 401 || status === 403) {
    return new ImageGenerationError({
      surface: 'provider_auth',
      reasonCode: 'provider_auth_rejected',
      message: `xAI image generation rejected the credential (status ${status})`,
    });
  }
  if (status === 429) {
    return new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_rate_limited',
      message: 'xAI rate limited the image generation request',
    });
  }
  return new ImageGenerationError({
    surface: 'provider_api',
    reasonCode: 'provider_request_failed',
    message: `xAI image generation request failed (status ${status})`,
  });
}

function readGrokGeneratedImage(body: unknown): GrokGeneratedImage | null {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return null;
  }
  const first: unknown = body.data[0];
  if (!isRecord(first)) {
    return null;
  }
  if (typeof first.b64_json !== 'string' || first.b64_json.length === 0) {
    return null;
  }
  return {
    b64: first.b64_json,
    ...(typeof first.revised_prompt === 'string' && first.revised_prompt
      ? { revisedPrompt: first.revised_prompt }
      : {}),
  };
}

export async function generateImageViaGrok(
  input: GrokImageProviderInput,
): Promise<GeneratedImageCandidate> {
  const model = resolveGrokImageModel(input.request.model);
  const url = resolveGrokImageGenerationsUrl();
  const fetchImpl = input.fetchImpl ?? fetch;

  const timeoutSignal = AbortSignal.timeout(resolveGrokImageTimeoutMs());
  const signal =
    input.signal !== undefined
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: input.request.prompt,
        n: 1,
        response_format: 'b64_json',
      }),
      signal,
    });
  } catch (error: unknown) {
    if (input.signal?.aborted === true) {
      throw error;
    }
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: timeoutSignal.aborted
        ? 'provider_request_timeout'
        : 'provider_network_failed',
      message: timeoutSignal.aborted
        ? 'xAI image generation request timed out'
        : 'xAI image generation request failed before a response arrived',
      cause: error,
    });
  }

  if (!response.ok) {
    // 본문은 읽어 소비하되(소켓 정리) 진단으로 내보내지 않는다.
    await response.text().catch(() => '');
    throw classifyGrokFailure(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_response_invalid',
      message: 'xAI image generation returned a non-JSON response',
      cause: error,
    });
  }

  const image = readGrokGeneratedImage(body);
  if (image === null) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'empty_image_result',
      message: 'xAI image generation response did not include image data',
    });
  }

  const asset = validateGeneratedImageBase64({ dataBase64: image.b64 });
  const now = input.now ?? (() => new Date().toISOString());
  return {
    asset,
    provenance: {
      providerId: 'grok_oauth',
      model,
      capability: 'image_generation',
      prompt: input.request.prompt,
      ...(image.revisedPrompt !== undefined
        ? { revisedPrompt: image.revisedPrompt }
        : {}),
      generatedAt: now(),
    },
  };
}
