/**
 * daemon/directory-preferences-store — 어디서 일하는지에 대한 사용자 선택
 *
 * 세 값이 한 문서에 있다. 전부 "작업 위치를 고르는 일"의 조각이고, 같은 시점에
 * 함께 바뀐다 — 폴더를 고르면 cwd가 정해지면서 최근 목록에도 올라간다. 파일을
 * 셋으로 쪼개면 원자적으로 못 쓰고 route와 조회 경로만 세 배가 된다.
 *
 * - workingDirectory: 지금 작업 시작 위치. daemon이 죽어도 살아남아야 한다.
 * - favorites: 사용자가 직접 고정한 폴더. 자동 발견 경로와 별개다.
 * - recents: 고른 폴더의 완전한 MRU 기록. 자동 발견 경로는 담지 않는다.
 *
 * 저장 위치: <homeStateRoot>/.geulbat/directory-preferences.json
 * 쓰기 전략: temp 파일 -> rename (atomic), 0600
 */

import { readFile } from 'node:fs/promises';

import type {
  DirectoryPreferenceEntry,
  DirectoryPreferencesResponse,
} from '@geulbat/protocol/files';

import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
import { isRecord } from './runtime-json.js';
import { writeTextFileAtomically } from './utils/atomic-file.js';
import { isNotFoundError } from './utils/error.js';

const PREFERENCES_FILE = 'directory-preferences.json';
const PREFERENCES_FILE_VERSION = 1;
const PREFERENCES_FILE_MODE = 0o600;

type DirectoryPreferenceAction =
  /** 작업 시작 위치로 고름 — cwd를 정하고 최근 목록에 올린다. */
  | { kind: 'select'; path: string }
  | { kind: 'pin'; path: string }
  | { kind: 'unpin'; path: string };

const EMPTY_PREFERENCES: DirectoryPreferencesResponse = {
  workingDirectory: null,
  favorites: [],
  recents: [],
};

function resolveDirectoryPreferencesFilePath(homeStateRoot: string): string {
  return joinWorkspaceGeulbatPath(homeStateRoot, PREFERENCES_FILE);
}

function readEntries(value: unknown): DirectoryPreferenceEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is DirectoryPreferenceEntry =>
      isRecord(entry) &&
      typeof entry['path'] === 'string' &&
      entry['path'].trim() !== '' &&
      typeof entry['at'] === 'string',
  );
}

/**
 * 문서를 읽는다. 파일이 없으면 첫 실행이다. 문서가 깨져 있으면 빈 값으로 시작한다 —
 * 여기서 실패를 던지면 어디서 일하는지 고르는 것 자체가 막혀 원래 기능까지 잃는다.
 * (승인 모드 저장소는 반대로 fail-loud다. 그건 권한이고 이건 편의값이다.)
 */
export async function readDirectoryPreferences(
  homeStateRoot: string,
): Promise<DirectoryPreferencesResponse> {
  let raw: string;
  try {
    raw = await readFile(
      resolveDirectoryPreferencesFilePath(homeStateRoot),
      'utf-8',
    );
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { ...EMPTY_PREFERENCES };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
  if (!isRecord(parsed) || parsed['version'] !== PREFERENCES_FILE_VERSION) {
    return { ...EMPTY_PREFERENCES };
  }
  const workingDirectory = parsed['workingDirectory'];
  return {
    workingDirectory:
      typeof workingDirectory === 'string' && workingDirectory.trim() !== ''
        ? workingDirectory
        : null,
    favorites: readEntries(parsed['favorites']),
    recents: readEntries(parsed['recents']),
  };
}

async function writeDirectoryPreferences(
  homeStateRoot: string,
  preferences: DirectoryPreferencesResponse,
): Promise<void> {
  await writeTextFileAtomically(
    resolveDirectoryPreferencesFilePath(homeStateRoot),
    `${JSON.stringify({ version: PREFERENCES_FILE_VERSION, ...preferences }, null, 2)}\n`,
    { mode: PREFERENCES_FILE_MODE },
  );
}

/**
 * 한 번의 원자적 쓰기로 문서를 갱신한다.
 *
 * `excludedPaths`는 선택기가 이미 자기 항목으로 보여주는 자동 발견 경로다. 최근
 * 목록에서만 뺀다 — 즐겨찾기는 사용자가 직접 고정한 것이므로, 자동 발견 경로와
 * 겹쳐도 사용자의 의도를 지운다.
 */
export async function applyDirectoryPreference(args: {
  homeStateRoot: string;
  action: DirectoryPreferenceAction;
  excludedPaths?: readonly string[];
  now?: () => Date;
}): Promise<DirectoryPreferencesResponse> {
  const path = args.action.path.trim();
  const current = await readDirectoryPreferences(args.homeStateRoot);
  if (path === '') {
    return current;
  }
  const at = (args.now?.() ?? new Date()).toISOString();

  const next: DirectoryPreferencesResponse = { ...current };
  switch (args.action.kind) {
    case 'select': {
      next.workingDirectory = path;
      if (args.excludedPaths?.includes(path) !== true) {
        next.recents = [
          { path, at },
          ...current.recents.filter((entry) => entry.path !== path),
        ];
      }
      break;
    }
    case 'pin': {
      if (current.favorites.some((entry) => entry.path === path)) {
        return current;
      }
      next.favorites = [...current.favorites, { path, at }];
      // 고정한 폴더는 최근 목록에서 뺀다 — 같은 줄이 두 번 보이지 않게 한다.
      next.recents = current.recents.filter((entry) => entry.path !== path);
      break;
    }
    case 'unpin': {
      if (!current.favorites.some((entry) => entry.path === path)) {
        return current;
      }
      next.favorites = current.favorites.filter((entry) => entry.path !== path);
      break;
    }
  }

  await writeDirectoryPreferences(args.homeStateRoot, next);
  return next;
}
