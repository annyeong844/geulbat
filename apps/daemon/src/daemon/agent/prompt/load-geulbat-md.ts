import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';

import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage, hasErrorCode } from '../../utils/error.js';

const GEULBAT_MD_FILENAME = 'geulbat.md';
const GEULBAT_MD_LOCAL_OVERRIDE_FILENAME = 'geulbat.local.md';
const INSTRUCTION_FILENAMES_BY_PRECEDENCE = [
  GEULBAT_MD_LOCAL_OVERRIDE_FILENAME,
  GEULBAT_MD_FILENAME,
] as const;
const PROJECT_ROOT_MARKERS = ['.git'] as const;
const MAX_INSTRUCTION_TOTAL_BYTES = 64 * 1024;

const logger = createLogger('agent/prompt/geulbat-md');

interface LoadedGeulbatInstructions {
  instructions: string | undefined;
  sources: readonly string[];
}

const EMPTY_RESULT: LoadedGeulbatInstructions = Object.freeze({
  instructions: undefined,
  sources: Object.freeze([]),
});

async function hasRootMarkerOfAnyKind(directory: string): Promise<boolean> {
  for (const marker of PROJECT_ROOT_MARKERS) {
    try {
      await stat(join(directory, marker));
      return true;
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function resolveDirectoriesFromRootToWorkingDirectory(
  workingDirectory: string,
): Promise<readonly string[]> {
  const chain: string[] = [];
  let current = workingDirectory;
  const { root } = parse(workingDirectory);
  for (;;) {
    chain.push(current);
    if (await hasRootMarkerOfAnyKind(current)) {
      return chain.reverse();
    }
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [workingDirectory];
}

async function readDirectoryInstruction(
  directory: string,
  remainingBytes: number,
): Promise<{ path: string; text: string; bytes: number } | undefined> {
  for (const filename of INSTRUCTION_FILENAMES_BY_PRECEDENCE) {
    const path = join(directory, filename);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error: unknown) {
      if (
        hasErrorCode(error, 'ENOENT') ||
        hasErrorCode(error, 'EISDIR') ||
        hasErrorCode(error, 'ENOTDIR')
      ) {
        continue;
      }
      logger
        .withContext({ path })
        .warn(
          'instruction file is unreadable; this directory contributes nothing instead of falling back to a lower-precedence file:',
          getErrorMessage(error),
        );
      return undefined;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > remainingBytes) {
      logger
        .withContext({
          path,
          bytes,
          remainingBytes,
          totalBudgetBytes: MAX_INSTRUCTION_TOTAL_BYTES,
        })
        .warn(
          'instruction file does not fit the remaining prompt budget; this directory contributes nothing instead of falling back to a lower-precedence file',
        );
      return undefined;
    }
    if (text.trim() === '') {
      continue;
    }
    return { path, text: text.trim(), bytes };
  }
  return undefined;
}

export async function loadGeulbatInstructions(
  workingDirectory: string | undefined,
): Promise<LoadedGeulbatInstructions> {
  if (workingDirectory === undefined || !isAbsolute(workingDirectory)) {
    return EMPTY_RESULT;
  }
  let rootToWorkingDirectory: readonly string[];
  try {
    rootToWorkingDirectory =
      await resolveDirectoriesFromRootToWorkingDirectory(workingDirectory);
  } catch (error: unknown) {
    logger
      .withContext({ workingDirectory })
      .warn(
        'project root discovery failed; no project instructions are applied:',
        getErrorMessage(error),
      );
    return EMPTY_RESULT;
  }

  const nearestFirst = [...rootToWorkingDirectory].reverse();
  const appliedNearestFirst: { path: string; text: string }[] = [];
  let remainingBytes = MAX_INSTRUCTION_TOTAL_BYTES;
  for (const directory of nearestFirst) {
    const found = await readDirectoryInstruction(directory, remainingBytes);
    if (found === undefined) {
      continue;
    }
    remainingBytes -= found.bytes;
    appliedNearestFirst.push(found);
  }
  if (appliedNearestFirst.length === 0) {
    return EMPTY_RESULT;
  }

  const applied = appliedNearestFirst.reverse();
  const sources = applied.map((entry) => entry.path);
  logger
    .withContext({
      fileCount: sources.length,
      sources: sources.join(', '),
      usedBytes: MAX_INSTRUCTION_TOTAL_BYTES - remainingBytes,
      totalBudgetBytes: MAX_INSTRUCTION_TOTAL_BYTES,
    })
    .info('project instructions applied to the system prompt');
  return {
    instructions: applied.map((entry) => entry.text).join('\n\n'),
    sources: Object.freeze(sources),
  };
}
