import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
} from '@geulbat/protocol/run-approval';

/**
 * 승인 모드 표시 캐시.
 *
 * 이 값은 진실이 아니다. 승인 모드의 durable 소유자는 daemon이고(`GET/PUT
 * /api/permission-mode`), 여기 남는 값은 daemon 응답이 도착하기 전 첫 페인트에서
 * 모드 배지가 깜빡이지 않게 하려는 힌트일 뿐이다. 실행 판정은 언제나 daemon이
 * 자기 저장소를 근거로 내린다.
 *
 * 따라서 이 캐시를 읽어서 권한을 결정하거나, daemon 조회 실패를 이 값으로 덮어
 * 넘기지 않는다.
 */

const PERMISSION_MODE_CACHE_KEY = 'geulbat.shell.permission-mode.v1';

type PermissionModeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function resolvePermissionModeStorage(
  storage?: PermissionModeStorage,
): PermissionModeStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readCachedPermissionMode(
  storage?: PermissionModeStorage,
): PermissionMode {
  try {
    const raw = resolvePermissionModeStorage(storage)?.getItem(
      PERMISSION_MODE_CACHE_KEY,
    );
    return raw != null && isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

export function cachePermissionMode(
  permissionMode: PermissionMode,
  storage?: PermissionModeStorage,
): void {
  try {
    resolvePermissionModeStorage(storage)?.setItem(
      PERMISSION_MODE_CACHE_KEY,
      permissionMode,
    );
  } catch {
    // 표시 캐시가 막혀도 daemon이 소유한 실제 모드는 그대로다.
  }
}
