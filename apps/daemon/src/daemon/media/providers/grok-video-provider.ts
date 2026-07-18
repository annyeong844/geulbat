import { GROK_OAUTH_RESPONSES_BASE_URL } from '../../llm/provider/grok-oauth-transport.js';
import { isRecord } from '../../runtime-json.js';
import { ImageGenerationError } from '../contract.js';

// xAI 동영상 생성 API 어댑터(video-generation-open §4.5) — 비동기 잡:
// POST /videos/generations → request_id → GET /videos/{id} 폴링 →
// done 시 video.url. S0 실측: pending→done(5초 영상 19~27s), 실패는
// {status:'failed', error:{code,message}}, duration 가드 1~15초, 2 req/s.
// OAuth bearer는 호출자(video-generation-runtime)가 provider-auth로 수급한다.

const DEFAULT_GROK_VIDEO_MODEL = 'grok-imagine-video-1.5';

// 우선순위(§4.1): 요청 스코프 모델(사용자 선택) > env knob > 내장 기본값
export function resolveGrokVideoModel(
  requestModel: string | undefined,
): string {
  return (
    requestModel ??
    process.env.GEULBAT_VIDEO_GENERATION_GROK_MODEL ??
    DEFAULT_GROK_VIDEO_MODEL
  );
}

function resolveGrokVideoGenerationsUrl(): string {
  return (
    process.env.GEULBAT_VIDEO_GENERATION_GROK_URL ??
    `${GROK_OAUTH_RESPONSES_BASE_URL}/videos/generations`
  );
}

function resolveGrokVideoStatusUrl(requestId: string): string {
  const base =
    process.env.GEULBAT_VIDEO_GENERATION_GROK_STATUS_URL ??
    `${GROK_OAUTH_RESPONSES_BASE_URL}/videos`;
  return `${base}/${encodeURIComponent(requestId)}`;
}

// 폴링 규범(§4.5) — 간격 기본 5s, 상한 기본 10분. env knob.
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveGrokVideoPollIntervalMs(): number {
  return resolvePositiveIntEnv(
    'GEULBAT_VIDEO_GENERATION_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
  );
}

export function resolveGrokVideoPollTimeoutMs(): number {
  return resolvePositiveIntEnv(
    'GEULBAT_VIDEO_GENERATION_POLL_TIMEOUT_MS',
    DEFAULT_POLL_TIMEOUT_MS,
  );
}

// 상태코드 분류는 이미지 어댑터와 동일 규범 — 업스트림 본문은 진단-프라이빗.
function classifyGrokVideoFailure(status: number): ImageGenerationError {
  if (status === 401 || status === 403) {
    return new ImageGenerationError({
      surface: 'provider_auth',
      reasonCode: 'provider_auth_rejected',
      message: `xAI video generation rejected the credential (status ${status})`,
    });
  }
  if (status === 429) {
    return new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_rate_limited',
      message: 'xAI rate limited the video generation request',
    });
  }
  return new ImageGenerationError({
    surface: 'provider_api',
    reasonCode: 'provider_request_failed',
    message: `xAI video generation request failed (status ${status})`,
  });
}

export interface GrokVideoProviderInput {
  request: {
    prompt: string;
    durationSeconds: number;
    model?: string;
    aspectRatio?: string;
    resolution?: string;
  };
  // 항상 존재한다 — 소스 없는 요청은 런타임이 투명 캔버스를 주입(D-V5)
  sourceImageDataUrl: string;
  auth: { accessToken: string };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface GrokGeneratedVideo {
  videoUrl: string;
  durationSeconds: number;
  model: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJsonOrThrow(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  phase: 'create' | 'poll',
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error: unknown) {
    if (init.signal?.aborted === true) {
      throw error;
    }
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_network_failed',
      message: `xAI video generation ${phase} request failed before a response arrived`,
      cause: error,
    });
  }
  if (!response.ok) {
    await response.text().catch(() => '');
    throw classifyGrokVideoFailure(response.status);
  }
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_response_invalid',
      message: `xAI video generation ${phase} returned a non-JSON response`,
      cause: error,
    });
  }
}

export async function generateVideoViaGrok(
  input: GrokVideoProviderInput,
): Promise<GrokGeneratedVideo> {
  const model = resolveGrokVideoModel(input.request.model);
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleepImpl ?? defaultSleep;
  const pollIntervalMs =
    input.pollIntervalMs ?? resolveGrokVideoPollIntervalMs();
  const pollTimeoutMs = input.pollTimeoutMs ?? resolveGrokVideoPollTimeoutMs();
  const headers = {
    Authorization: `Bearer ${input.auth.accessToken}`,
    'Content-Type': 'application/json',
  };

  const created = await fetchJsonOrThrow(
    fetchImpl,
    resolveGrokVideoGenerationsUrl(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        prompt: input.request.prompt,
        duration: input.request.durationSeconds,
        image: { url: input.sourceImageDataUrl },
        // 상세 옵션(실측 enum — 프로토콜 가드가 상류에서 강제). 미지정이면
        // 필드 자체를 싣지 않아 프로바이더 기본을 따른다.
        ...(input.request.aspectRatio !== undefined
          ? { aspect_ratio: input.request.aspectRatio }
          : {}),
        ...(input.request.resolution !== undefined
          ? { resolution: input.request.resolution }
          : {}),
      }),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
    'create',
  );
  const requestId =
    isRecord(created) && typeof created.request_id === 'string'
      ? created.request_id
      : null;
  if (requestId === null) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_response_invalid',
      message: 'xAI video generation did not return a request id',
    });
  }

  // 폴링 — 취소(AbortSignal)는 즉시 전파, 상한 초과는 timeout 분류(§4.4)
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    if (input.signal?.aborted === true) {
      throw new Error('video generation was aborted');
    }
    await sleep(pollIntervalMs);
    const body = await fetchJsonOrThrow(
      fetchImpl,
      resolveGrokVideoStatusUrl(requestId),
      {
        headers: { Authorization: headers.Authorization },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
      'poll',
    );
    const status = isRecord(body) ? body.status : undefined;
    if (status === 'pending' || status === undefined) {
      continue;
    }
    if (status === 'expired') {
      throw new ImageGenerationError({
        surface: 'provider_api',
        reasonCode: 'provider_request_timeout',
        message: 'xAI video generation job expired before completion',
      });
    }
    if (status === 'failed') {
      const errorRecord = isRecord(body) ? body.error : undefined;
      const code =
        isRecord(errorRecord) && typeof errorRecord.code === 'string'
          ? errorRecord.code
          : 'unknown';
      throw new ImageGenerationError({
        surface: 'provider_api',
        reasonCode: 'provider_response_invalid',
        message: `xAI video generation job failed (code ${code})`,
      });
    }
    if (status === 'done') {
      const video = isRecord(body) ? body.video : undefined;
      const videoUrl =
        isRecord(video) && typeof video.url === 'string' ? video.url : null;
      if (videoUrl === null) {
        throw new ImageGenerationError({
          surface: 'provider_api',
          reasonCode: 'empty_image_result',
          message: 'xAI video generation completed without a video url',
        });
      }
      const durationSeconds =
        isRecord(video) && typeof video.duration === 'number'
          ? video.duration
          : input.request.durationSeconds;
      return { videoUrl, durationSeconds, model };
    }
    // 알 수 없는 상태는 pending으로 취급하지 않는다 — 명시적 실패(fail-closed)
    const statusDetail =
      typeof status === 'string' ? status : JSON.stringify(status);
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_response_invalid',
      message: `xAI video generation returned an unknown status: ${statusDetail ?? 'unknown'}`,
    });
  }

  throw new ImageGenerationError({
    surface: 'provider_api',
    reasonCode: 'provider_request_timeout',
    message: 'xAI video generation polling exceeded the configured ceiling',
  });
}
