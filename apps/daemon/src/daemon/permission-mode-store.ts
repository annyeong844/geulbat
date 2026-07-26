/**
 * daemon/permission-mode-store — 승인 모드의 durable 소유자
 *
 * 승인 모드(basic/full_access)는 안전 관련 설정이므로 실행 권한을 가진 daemon이
 * 소유한다. 예전에는 web-shell의 localStorage가 유일한 저장소였고, 브라우저 저장소를
 * 지우면 안전 설정이 조용히 바뀌었으며 탭이 여러 개면 서로 다른 값을 들고 있었다.
 *
 * 저장 위치: <homeStateRoot>/.geulbat/permission-mode.json (사용자 범위, 워크스페이스 아님)
 * 쓰기 전략: temp 파일 -> rename (atomic), 0600
 */

import { readFile } from 'node:fs/promises';

import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
  type PermissionModeState,
} from '@geulbat/protocol/run-approval';

import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
import { isRecord } from './runtime-json.js';
import { writeTextFileAtomically } from './utils/atomic-file.js';
import { isNotFoundError } from './utils/error.js';

const PERMISSION_MODE_FILE = 'permission-mode.json';
const PERMISSION_MODE_FILE_VERSION = 1;
const PERMISSION_MODE_FILE_MODE = 0o600;

/**
 * 저장된 문서가 깨져 있을 때 던진다. 조용히 기본값으로 덮으면 사용자가 켜 둔
 * full_access가 이유 없이 사라진 것처럼 보이고, 반대로 손상된 값을 신뢰하면 안전
 * 설정이 오염된다. 그래서 호출자가 진단을 남기고 안전한 방향으로 실패하게 만든다.
 */
export class PermissionModeStoreCorruptError extends Error {
  readonly code = 'corrupt';
  readonly filePath: string;

  constructor(filePath: string, reason: string) {
    super(`stored permission mode is unreadable (${filePath}): ${reason}`);
    this.name = 'PermissionModeStoreCorruptError';
    this.filePath = filePath;
  }
}

export function resolvePermissionModeFilePath(homeStateRoot: string): string {
  return joinWorkspaceGeulbatPath(homeStateRoot, PERMISSION_MODE_FILE);
}

/**
 * 저장된 모드를 읽는다. 파일이 아직 없는 것은 실패가 아니라 첫 실행이므로 기본값
 * basic을 돌려준다. 파일이 있는데 해석할 수 없으면 던진다.
 */
export async function readPermissionModeState(
  homeStateRoot: string,
): Promise<PermissionModeState> {
  const filePath = resolvePermissionModeFilePath(homeStateRoot);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { permissionMode: DEFAULT_PERMISSION_MODE, updatedAt: null };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PermissionModeStoreCorruptError(
      filePath,
      error instanceof Error ? error.message : 'invalid JSON',
    );
  }

  if (!isRecord(parsed)) {
    throw new PermissionModeStoreCorruptError(filePath, 'not a JSON object');
  }
  if (parsed['version'] !== PERMISSION_MODE_FILE_VERSION) {
    throw new PermissionModeStoreCorruptError(
      filePath,
      `unsupported version ${JSON.stringify(parsed['version'])}`,
    );
  }
  const storedMode = parsed['permissionMode'];
  if (!isPermissionMode(storedMode)) {
    throw new PermissionModeStoreCorruptError(
      filePath,
      `unknown permission mode ${JSON.stringify(storedMode)}`,
    );
  }
  const storedUpdatedAt = parsed['updatedAt'];
  if (typeof storedUpdatedAt !== 'string') {
    throw new PermissionModeStoreCorruptError(filePath, 'missing updatedAt');
  }

  return { permissionMode: storedMode, updatedAt: storedUpdatedAt };
}

export async function writePermissionModeState(
  homeStateRoot: string,
  permissionMode: PermissionMode,
  now: () => Date = () => new Date(),
): Promise<PermissionModeState> {
  const updatedAt = now().toISOString();
  const document = {
    version: PERMISSION_MODE_FILE_VERSION,
    permissionMode,
    updatedAt,
  };
  await writeTextFileAtomically(
    resolvePermissionModeFilePath(homeStateRoot),
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: PERMISSION_MODE_FILE_MODE },
  );
  return { permissionMode, updatedAt };
}
