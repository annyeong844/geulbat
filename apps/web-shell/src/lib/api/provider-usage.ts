import {
  isProviderUsageResponse,
  type ProviderUsageResponse,
} from '@geulbat/protocol/provider-usage';

import { apiFetch } from './client.js';

/**
 * 제공자가 보고하는 사용량. 값의 소유자는 제공자이므로 shell은 사본을 들지 않고,
 * 캐시 수명은 daemon이 정한다. forceRefresh는 그 캐시를 건너뛴다.
 */
export function fetchProviderUsage(options?: {
  forceRefresh?: boolean;
}): Promise<ProviderUsageResponse> {
  return apiFetch(
    options?.forceRefresh === true
      ? '/api/provider-usage?refresh=1'
      : '/api/provider-usage',
    undefined,
    isProviderUsageResponse,
  );
}
