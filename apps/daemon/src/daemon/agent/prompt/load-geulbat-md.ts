import { randomUUID } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
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
const STARTER_GEULBAT_MD = [
  '# 글밭 프로젝트 지침',
  '',
  '<!-- 이 폴더에서 글밭이 따라야 할 규칙과 작업 방식을 여기에 적어 주세요. -->',
  '',
].join('\n');

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

async function hasAnyGeulbatInstructionFile(
  directories: readonly string[],
): Promise<boolean> {
  for (const directory of directories) {
    for (const filename of INSTRUCTION_FILENAMES_BY_PRECEDENCE) {
      const path = join(directory, filename);
      try {
        await stat(path);
        return true;
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
          continue;
        }
        logger
          .withContext({ path })
          .warn(
            'instruction file presence could not be checked; starter creation is skipped to preserve any existing file:',
            getErrorMessage(error),
          );
        return true;
      }
    }
  }
  return false;
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

export async function loadOrCreateGeulbatInstructions(
  workingDirectory: string | undefined,
): Promise<LoadedGeulbatInstructions> {
  const loaded = await loadGeulbatInstructions(workingDirectory);
  if (
    loaded.sources.length > 0 ||
    workingDirectory === undefined ||
    !isAbsolute(workingDirectory)
  ) {
    return loaded;
  }

  let rootToWorkingDirectory: readonly string[];
  try {
    rootToWorkingDirectory =
      await resolveDirectoriesFromRootToWorkingDirectory(workingDirectory);
  } catch (error: unknown) {
    logger
      .withContext({ workingDirectory })
      .warn(
        'project root discovery failed during starter creation; existing files remain unchanged:',
        getErrorMessage(error),
      );
    return loaded;
  }
  if (await hasAnyGeulbatInstructionFile(rootToWorkingDirectory)) {
    return loaded;
  }

  const projectRoot = rootToWorkingDirectory[0] ?? workingDirectory;
  const path = join(projectRoot, GEULBAT_MD_FILENAME);
  const temporaryPath = join(
    projectRoot,
    `.geulbat.md.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, STARTER_GEULBAT_MD, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await link(temporaryPath, path);
    logger
      .withContext({ path })
      .info('starter project instruction file created');
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) {
      logger
        .withContext({ path })
        .warn(
          'starter project instruction file could not be created; the run continues without changing existing files:',
          getErrorMessage(error),
        );
      return loaded;
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) {
        logger
          .withContext({ path: temporaryPath })
          .warn(
            'starter project instruction temporary file could not be removed:',
            getErrorMessage(error),
          );
      }
    }
  }
  return await loadGeulbatInstructions(workingDirectory);
}
