import { isProviderAuthProviderId } from './provider-auth.js';
import type { ProviderAuthProviderId } from './provider-auth.js';
import { isNumber, isRecord, isString } from './wire-value-guards.js';

/**
 * 제공자가 보고하는 사용량. 우리가 토큰을 세지 않고 제공자에게 물어본 값이므로
 * 저장하지 않고 조회 시점의 스냅샷으로 다룬다.
 *
 * 봉투(providerId + state)는 제공자끼리 공유하지만 측정값은 공유하지 않는다.
 * 제공자마다 보고 단위가 다를 수 있으므로 측정값은 판별 가능한 형태로 둔다 —
 * 지금은 사용률 창만 쓰지만, 금액처럼 다른 단위가 생기면 새 변형으로 더한다.
 */

/** 사용률 창 하나 — 제공자가 % 기준으로 보고하는 형태(Codex). */
export interface ProviderUsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  /** 창이 초기화되는 시각(ISO). 제공자가 주지 않으면 생략. */
  resetAt?: string;
}

export type ProviderUsageMeasurement = {
  kind: 'windows';
  windows: ProviderUsageWindow[];
};

/**
 * 제공자별 결과. 네 상태를 구분하는 이유는 조용한 대체를 막기 위해서다 —
 * 조회에 실패했는데 0을 보여주거나 로컬 추정치로 채우면 사용자가 그것을 사실로
 * 읽는다.
 */
export type ProviderUsageEntry =
  | { providerId: ProviderAuthProviderId; state: 'not_connected' }
  | {
      providerId: ProviderAuthProviderId;
      state: 'not_provided';
      /** 왜 제공되지 않는지 — 사용자에게 그대로 보여줄 수 있는 설명. */
      reason: string;
    }
  | {
      providerId: ProviderAuthProviderId;
      state: 'failed';
      /** 진단용 메시지. 자격증명 값은 절대 담지 않는다. */
      message: string;
    }
  | {
      providerId: ProviderAuthProviderId;
      state: 'reported';
      measurement: ProviderUsageMeasurement;
      /** 이 스냅샷을 읽은 시각(ISO). */
      readAt: string;
      /** 제공자가 알려준 플랜 이름. 없으면 생략. */
      planLabel?: string;
    };

export interface ProviderUsageResponse {
  providers: ProviderUsageEntry[];
}

function isProviderUsageWindow(value: unknown): value is ProviderUsageWindow {
  return (
    isRecord(value) &&
    isNumber(value['usedPercent']) &&
    (value['label'] === undefined || isString(value['label'])) &&
    (value['windowMinutes'] === undefined ||
      isNumber(value['windowMinutes'])) &&
    (value['resetAt'] === undefined || isString(value['resetAt']))
  );
}

function isProviderUsageMeasurement(
  value: unknown,
): value is ProviderUsageMeasurement {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['kind'] === 'windows' &&
    Array.isArray(value['windows']) &&
    value['windows'].every(isProviderUsageWindow)
  );
}

export function isProviderUsageEntry(
  value: unknown,
): value is ProviderUsageEntry {
  if (!isRecord(value) || !isProviderAuthProviderId(value['providerId'])) {
    return false;
  }
  switch (value['state']) {
    case 'not_connected':
      return true;
    case 'not_provided':
      return isString(value['reason']);
    case 'failed':
      return isString(value['message']);
    case 'reported':
      return (
        isProviderUsageMeasurement(value['measurement']) &&
        isString(value['readAt']) &&
        (value['planLabel'] === undefined || isString(value['planLabel']))
      );
    default:
      return false;
  }
}

export function isProviderUsageResponse(
  value: unknown,
): value is ProviderUsageResponse {
  return (
    isRecord(value) &&
    Array.isArray(value['providers']) &&
    value['providers'].every(isProviderUsageEntry)
  );
}
