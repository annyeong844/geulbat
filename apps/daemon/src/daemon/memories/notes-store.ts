import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage, hasErrorCode } from '../utils/error.js';

const MEMORIES_DIRECTORY_NAME = 'memories';
const NOTES_DIRECTORY_NAME = 'notes';
const CURRENT_DIRECTORY_NAME = 'current';
const HISTORICAL_DIRECTORY_NAME = 'historical';
const LEGACY_STATE_FILE_NAME = 'state.json';
const SUMMARY_FILE_NAME = 'summary.md';
const NOTE_FILE_EXTENSION = '.md';
let lastAllocatedMemoryNoteTimestampMs = Number.NEGATIVE_INFINITY;

/**
 * 통합을 부르는 미통합 노트 개수. 하나로 두 가지를 정한다 — 프롬프트가 상시로
 * 실어 가는 미통합 노트의 양, 그리고 통합 모델 호출의 빈도.
 */
const CONSOLIDATION_PENDING_NOTE_THRESHOLD = 10;

const logger = createLogger('memories/notes-store');

export interface MemoryNote {
  fileName: string;
  path: string;
  text: string;
}

export function resolveMemoriesRoot(stateRoot: string): string {
  return join(stateRoot, MEMORIES_DIRECTORY_NAME);
}

function resolveNotesRoot(stateRoot: string): string {
  return join(resolveMemoriesRoot(stateRoot), NOTES_DIRECTORY_NAME);
}

/** 아직 통합되지 않은 노트. 프롬프트가 읽는 곳이고 개수가 임계값 근처로 유지된다. */
export function resolveCurrentMemoryNotesDirectory(stateRoot: string): string {
  return join(resolveNotesRoot(stateRoot), CURRENT_DIRECTORY_NAME);
}

/** 통합이 흡수한 노트. 삭제하지 않고 여기로 옮긴다 — 읽는 경로는 없다. */
export function resolveHistoricalMemoryNotesDirectory(
  stateRoot: string,
): string {
  return join(resolveNotesRoot(stateRoot), HISTORICAL_DIRECTORY_NAME);
}

export function resolveMemorySummaryPath(stateRoot: string): string {
  return join(resolveMemoriesRoot(stateRoot), SUMMARY_FILE_NAME);
}

export function memoryConsolidationIsDue(pendingNoteCount: number): boolean {
  return pendingNoteCount >= CONSOLIDATION_PENDING_NOTE_THRESHOLD;
}

function createNoteFileName(): string {
  const timestampMs = Math.max(
    Date.now(),
    lastAllocatedMemoryNoteTimestampMs + 1,
  );
  lastAllocatedMemoryNoteTimestampMs = timestampMs;
  const timestamp = new Date(timestampMs).toISOString().replaceAll(':', '-');
  return `${timestamp}-${randomBytes(4).toString('hex')}${NOTE_FILE_EXTENSION}`;
}

export async function appendMemoryNote(
  stateRoot: string,
  note: string,
): Promise<{ path: string }> {
  const text = note.trim();
  if (text === '') {
    throw Object.assign(new Error('note must not be empty.'), {
      code: 'invalid_args',
    });
  }
  const directory = resolveCurrentMemoryNotesDirectory(stateRoot);
  const path = join(directory, createNoteFileName());
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${text}\n`, { encoding: 'utf8', flag: 'wx' });
  return { path };
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text === '' ? undefined : text;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return undefined;
    }
    logger
      .withContext({ path })
      .warn(
        'memory file is unreadable; it is left out:',
        getErrorMessage(error),
      );
    return undefined;
  }
}

/**
 * 슬라이스 2가 남긴 단일 요약 파일. 항목 집합으로 넘어온 뒤에는 첫 통합의
 * 입력으로만 쓰이고, 통합이 성공하면 제거된다.
 */
export async function readLegacyMemorySummary(
  stateRoot: string,
): Promise<string | undefined> {
  return await readOptionalTextFile(resolveMemorySummaryPath(stateRoot));
}

export async function removeLegacyMemorySummary(
  stateRoot: string,
): Promise<void> {
  await rm(resolveMemorySummaryPath(stateRoot), { force: true });
}

async function listNoteFileNames(
  directory: string,
): Promise<readonly string[]> {
  try {
    return (await readdir(directory))
      .filter((entry) => entry.endsWith(NOTE_FILE_EXTENSION))
      .sort();
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return [];
    }
    logger
      .withContext({ directory })
      .warn(
        'memory notes directory is unreadable; those notes are not carried:',
        getErrorMessage(error),
      );
    return [];
  }
}

async function readNotesFrom(
  directory: string,
): Promise<readonly MemoryNote[]> {
  const notes: MemoryNote[] = [];
  for (const fileName of await listNoteFileNames(directory)) {
    const path = join(directory, fileName);
    const text = await readOptionalTextFile(path);
    if (text === undefined) {
      continue;
    }
    notes.push({ fileName, path, text });
  }
  return notes;
}

/**
 * 미통합 노트. `current/`에 남아 있는 것이 곧 미통합이므로 워터마크가 없다.
 *
 * `notes/` 바로 아래에 있는 파일은 current/historical 분리 이전에 쓰인 것이다.
 * 프롬프트에서 조용히 사라지지 않도록 미통합으로 함께 싣고, 첫 통합에서
 * historical로 옮겨진다.
 */
export async function listPendingMemoryNotes(
  stateRoot: string,
): Promise<readonly MemoryNote[]> {
  const [legacy, current] = await Promise.all([
    readNotesFrom(resolveNotesRoot(stateRoot)),
    readNotesFrom(resolveCurrentMemoryNotesDirectory(stateRoot)),
  ]);
  if (legacy.length > 0) {
    logger
      .withContext({ noteCount: legacy.length })
      .info('notes from before the current/historical split are pending');
  }
  return [...legacy, ...current];
}

/**
 * 흡수한 노트를 historical로 옮긴다. 항목을 확정한 **뒤에** 부른다 — 그 사이에
 * 죽으면 옮기지 못한 노트가 미통합으로 남아 다시 통합되므로 재실행이 안전하다.
 * 순서를 뒤집으면 노트가 historical로 사라진 채 항목에 반영되지 않는다.
 */
export async function archiveConsolidatedMemoryNotes(
  stateRoot: string,
  notes: readonly MemoryNote[],
): Promise<{ archivedCount: number }> {
  if (notes.length === 0) {
    return { archivedCount: 0 };
  }
  const historical = resolveHistoricalMemoryNotesDirectory(stateRoot);
  await mkdir(historical, { recursive: true });
  let archivedCount = 0;
  for (const note of notes) {
    try {
      await rename(note.path, join(historical, note.fileName));
      archivedCount += 1;
    } catch (error: unknown) {
      // 옮기지 못한 노트는 미통합으로 남는다. 다음 통합이 다시 흡수한다.
      logger
        .withContext({ path: note.path })
        .warn(
          'consolidated note could not be archived; it stays pending:',
          getErrorMessage(error),
        );
    }
  }
  await rm(join(resolveMemoriesRoot(stateRoot), LEGACY_STATE_FILE_NAME), {
    force: true,
  });
  return { archivedCount };
}
