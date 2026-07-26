import {
  isPermissionModeState,
  type PermissionMode,
  type PermissionModeState,
  type PermissionModeUpdateRequest,
} from '@geulbat/protocol/run-approval';

import { apiFetch } from './client.js';

/**
 * 승인 모드의 durable 소유자는 daemon이다. shell은 여기서 읽은 값을 진실로 쓰고,
 * localStorage는 첫 페인트용 표시 캐시로만 남는다.
 */
export function fetchPermissionMode(): Promise<PermissionModeState> {
  return apiFetch('/api/permission-mode', undefined, isPermissionModeState);
}

export function savePermissionMode(
  permissionMode: PermissionMode,
): Promise<PermissionModeState> {
  const request: PermissionModeUpdateRequest = { permissionMode };
  return apiFetch(
    '/api/permission-mode',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isPermissionModeState,
  );
}
