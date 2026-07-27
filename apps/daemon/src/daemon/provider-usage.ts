/**
 * daemon/provider-usage — 제공자가 보고하는 사용량 조회
 *
 * 우리가 토큰을 세지 않는다. 제공자에게 "내 한도가 얼마나 남았나"를 물어보고 그
 * 응답을 그대로 옮긴다. 그래서 영속 저장이 없고, 짧은 메모리 캐시만 둔다
 * (PROVIDER_USAGE_CACHE_TTL_MS).
 *
 * 중복을 피하는 방식은 봉투 공유다. 자격증명 확인, 상태 분류(미연결/미제공/
 * 실패/보고됨), 오류 처리는 여기 한 번만 있고, 제공자별 코드는 "인증된 GET을
 * 어디로 보내고 응답을 어떤 측정값으로 읽는가"만 담당한다.
 *
 * 자격증명은 여기서 값으로 다루지 않는다 — 호출자가 넘긴 토큰을 헤더에 실을
 * 뿐이고, 로그·오류 메시지에 담지 않는다.
 */

import type {
  ProviderUsageEntry,
  ProviderUsageMeasurement,
} from '@geulbat/protocol/provider-usage';
import {
  PROVIDER_AUTH_PROVIDER_IDS,
  type ProviderAuthProviderId,
} from '@geulbat/protocol/provider-auth';
import { isRecord } from './runtime-json.js';
import { getErrorCode } from './utils/error.js';
import { resolveCodexResponsesUrl } from './llm/provider/transport/responses-websocket-url.js';

/** 제공자별 어댑터. 봉투는 공유하고 이 두 가지만 제공자마다 다르다. */
interface ProviderUsageAdapter {
  /** 인증된 GET 대상. base는 이미 코드에 있는 전송 상수에서 파생한다. */
  buildRequest(credential: ProviderUsageCredential): {
    url: string;
    headers: Record<string, string>;
  };
  /** 제공자 응답을 측정값으로 좁힌다. 해석할 수 없으면 null. */
  readMeasurement(body: unknown): {
    measurement: ProviderUsageMeasurement;
    planLabel?: string;
  } | null;
}

interface ProviderUsageCredential {
  accessToken: string;
  accountId: string;
}

export interface ProviderUsageFetchDeps {
  /** 연결된 자격증명. 없으면 미연결로 분류한다. */
  loadCredential(
    providerId: ProviderAuthProviderId,
  ): Promise<ProviderUsageCredential | null>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 조회 대상. 기본은 지원하는 제공자 전체이며, 테스트가 좁힐 때만 넘긴다. */
  providerIds?: readonly ProviderAuthProviderId[];
  /** 캐시를 무시하고 제공자에게 다시 묻는다 — 사용자가 새로고침을 누른 경우. */
  forceRefresh?: boolean;
}

/**
 * 실패 사유를 자격증명이 섞일 수 없는 형태로 좁힌다.
 *
 * 이 경로는 외부 네트워크 경계이고 바로 옆에 토큰이 있다. 하위 오류 메시지를
 * 그대로 사용자에게 돌려주면 언젠가 그 안에 헤더나 URL 조각이 실려 나올 수
 * 있으므로, 종류와 코드만 옮긴다.
 */
function describeFailureWithoutCredentials(error: unknown): string {
  const code = getErrorCode(error);
  const name = error instanceof Error ? error.name : 'UnknownError';
  return code === undefined ? name : `${name} (${code})`;
}

/**
 * 조회 결과 캐시 수명.
 *
 * 이 값은 원격 스냅샷을 다시 읽는 간격일 뿐이고 제품 동작을 정하지 않는다. 설정을
 * 열 때마다 제공자 왕복을 기다리면 화면이 느리고, 사용률은 초 단위로 바뀌는 값이
 * 아니다. 참조 구현(OpenCodex `MAIN_CACHE_TTL`)과 같은 5분을 쓰고, 사용자가
 * 새로고침을 누르면 항상 강제로 다시 읽는다.
 */
const PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60_000;

interface CachedProviderUsage {
  entry: ProviderUsageEntry;
  readAtMs: number;
}

const providerUsageCache = new Map<
  ProviderAuthProviderId,
  CachedProviderUsage
>();

/** 테스트가 프로세스 전역 캐시를 남기지 않도록 비운다. */
export function clearProviderUsageCacheForTests(): void {
  providerUsageCache.clear();
}

export async function fetchProviderUsage(
  deps: ProviderUsageFetchDeps,
): Promise<ProviderUsageEntry[]> {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const entries: ProviderUsageEntry[] = [];
  for (const providerId of deps.providerIds ?? PROVIDER_AUTH_PROVIDER_IDS) {
    const cached = providerUsageCache.get(providerId);
    if (
      deps.forceRefresh !== true &&
      cached !== undefined &&
      nowMs - cached.readAtMs < PROVIDER_USAGE_CACHE_TTL_MS
    ) {
      entries.push(cached.entry);
      continue;
    }
    const entry = await fetchOneProviderUsage(providerId, deps);
    // 실패는 캐시하지 않는다 — 일시적 장애를 5분 동안 굳히지 않는다.
    if (entry.state === 'reported' || entry.state === 'not_provided') {
      providerUsageCache.set(providerId, { entry, readAtMs: nowMs });
    }
    entries.push(entry);
  }
  return entries;
}

async function fetchOneProviderUsage(
  providerId: ProviderAuthProviderId,
  deps: ProviderUsageFetchDeps,
): Promise<ProviderUsageEntry> {
  const notProvided = NOT_PROVIDED_REASONS[providerId];
  if (notProvided !== undefined) {
    return { providerId, state: 'not_provided', reason: notProvided };
  }
  const adapter = PROVIDER_USAGE_ADAPTERS[providerId];
  if (adapter === undefined) {
    return {
      providerId,
      state: 'not_provided',
      reason: '',
    };
  }

  let credential: ProviderUsageCredential | null;
  try {
    credential = await deps.loadCredential(providerId);
  } catch (error: unknown) {
    return {
      providerId,
      state: 'failed',
      message: `자격증명을 읽지 못했습니다 (${describeFailureWithoutCredentials(error)}).`,
    };
  }
  if (credential === null) {
    return { providerId, state: 'not_connected' };
  }

  const request = adapter.buildRequest(credential);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers,
    });
  } catch (error: unknown) {
    // 자격증명이 아니라 전송 실패만 남긴다.
    return {
      providerId,
      state: 'failed',
      message: `사용량 조회 요청이 실패했습니다 (${describeFailureWithoutCredentials(error)}).`,
    };
  }
  if (!response.ok) {
    return {
      providerId,
      state: 'failed',
      message: `제공자가 사용량 조회를 거부했습니다 (HTTP ${response.status}).`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    return {
      providerId,
      state: 'failed',
      message: `사용량 응답을 해석하지 못했습니다 (${describeFailureWithoutCredentials(error)}).`,
    };
  }

  const read = adapter.readMeasurement(body);
  if (read === null) {
    // 모양이 달라졌으면 0으로 꾸미지 않고 실패로 남긴다.
    return {
      providerId,
      state: 'failed',
      message: '제공자 사용량 응답에서 알려진 항목을 찾지 못했습니다.',
    };
  }
  return {
    providerId,
    state: 'reported',
    measurement: read.measurement,
    readAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(read.planLabel === undefined ? {} : { planLabel: read.planLabel }),
  };
}

// ─── Codex ───
//
// 사용률 창을 % 로 보고한다. 필드 이름은 Codex CLI가 읽는 것과 같다.

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Codex `/wham/usage` 응답의 창 하나.
 *
 * 시간 단위가 초다 — `limit_window_seconds`, `reset_at`(epoch 초). 분으로 착각하면
 * "5시간 한도"가 "5분 한도"로 표시된다.
 */
function readCodexWindow(value: unknown): ProviderUsageWindowInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = readOptionalNumber(value['used_percent']);
  if (usedPercent === undefined) {
    return null;
  }
  const windowSeconds = readOptionalNumber(value['limit_window_seconds']);
  const resetAtSeconds = readOptionalNumber(value['reset_at']);
  const resetAfterSeconds = readOptionalNumber(value['reset_after_seconds']);
  const resetAt =
    resetAtSeconds !== undefined
      ? new Date(resetAtSeconds * 1000)
      : resetAfterSeconds !== undefined
        ? new Date(Date.now() + resetAfterSeconds * 1000)
        : undefined;
  return {
    usedPercent,
    ...(windowSeconds === undefined
      ? {}
      : { windowMinutes: Math.round(windowSeconds / 60) }),
    ...(resetAt === undefined ? {} : { resetAt: resetAt.toISOString() }),
  };
}

type ProviderUsageWindowInput = Extract<
  ProviderUsageMeasurement,
  { kind: 'windows' }
>['windows'][number];

const CODEX_USAGE_ADAPTER: ProviderUsageAdapter = {
  buildRequest(credential) {
    return {
      url: resolveCodexUsageUrl(),
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'chatgpt-account-id': credential.accountId,
        accept: 'application/json',
      },
    };
  },
  readMeasurement(body) {
    if (!isRecord(body)) {
      return null;
    }
    // 개인 식별 필드(email, user_id, account_id)는 읽지 않는다 — 화면에 필요하지
    // 않고, 옮기지 않는 것이 유출 경로를 없애는 가장 확실한 방법이다.
    // 창은 최대 세 개이며 없는 창은 명시적 null로 온다. 라벨을 고정하지 않고
    // 창 길이가 이름을 정하게 한다 — "보조 한도"보다 "7일 한도"가 읽기 쉽다.
    const rateLimit = isRecord(body['rate_limit']) ? body['rate_limit'] : {};
    const windows: ProviderUsageWindowInput[] = [];
    for (const slot of [
      'primary_window',
      'secondary_window',
      'tertiary_window',
    ] as const) {
      const parsed = readCodexWindow(rateLimit[slot]);
      if (parsed !== null) {
        windows.push(parsed);
      }
    }
    if (windows.length === 0) {
      return null;
    }
    const planType = body['plan_type'];
    return {
      measurement: { kind: 'windows', windows },
      ...(typeof planType === 'string' && planType.trim() !== ''
        ? { planLabel: planType }
        : {}),
    };
  },
};

const PROVIDER_USAGE_ADAPTERS: Partial<
  Record<ProviderAuthProviderId, ProviderUsageAdapter>
> = {
  openai_codex_direct: CODEX_USAGE_ADAPTER,
};

/**
 * 제공자가 사용량 조회를 우리 자격증명으로 제공하지 않는 경우.
 *
 * Grok 크레딧 엔드포인트는 존재하지만 Responses OAuth 토큰을 받지 않으므로
 * 매번 실패할 호출을 보내지 않는다. UI는 state만 쓰고 reason 문구는 노출하지
 * 않으므로 wire 계약용 빈 문자열만 둔다.
 */
const NOT_PROVIDED_REASONS: Partial<Record<ProviderAuthProviderId, string>> = {
  grok_oauth: '',
};

/**
 * Codex 사용량 URL. 새 호스트 상수를 만들지 않고 이미 있는 responses URL 해석기에서
 * 파생시킨다 — 호스트와 `GEULBAT_BACKEND_URL` override가 한 곳에서만 정의되도록
 * 유지한다.
 */
export function resolveCodexUsageUrl(configuredUrl?: string): string {
  const url = new URL(resolveCodexResponsesUrl(configuredUrl));
  // .../backend-api/codex/responses -> .../backend-api/wham/usage
  const segments = url.pathname.split('/').filter((part) => part !== '');
  const backendApiIndex = segments.lastIndexOf('backend-api');
  const base =
    backendApiIndex >= 0 ? segments.slice(0, backendApiIndex + 1) : segments;
  url.pathname = `/${[...base, 'wham', 'usage'].join('/')}`;
  url.search = '';
  return url.toString();
}
