import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@geulbat/structured-logger/logger';
import { getErrorCode, getErrorMessage, isNotFoundError } from './error.js';

type RenameLike = Pick<typeof fs, 'rename' | 'unlink'>;
type AtomicReplaceLike = Pick<typeof fs, 'mkdir' | 'rename' | 'unlink'>;
export type AtomicWriteLike = Pick<
  typeof fs,
  'mkdir' | 'writeFile' | 'rename' | 'unlink'
>;
const logger = createLogger('atomic-file');

interface AtomicWriteOptions {
  mode?: number;
  atomicFs?: AtomicWriteLike | undefined;
  validateBeforeCommit?: (() => Promise<void>) | undefined;
}

export class AtomicReplaceConflictError extends Error {
  readonly code = 'conflict';
  readonly targetPath: string;

  constructor(targetPath: string) {
    super(
      `atomic replace conflict: target changed during fallback (${targetPath})`,
    );
    this.name = 'AtomicReplaceConflictError';
    this.targetPath = targetPath;
  }
}

export class AtomicBackupRestoreFailedError extends Error {
  readonly code = 'internal';
  readonly targetPath: string;
  readonly backupPath: string;
  readonly replaceError: unknown;

  constructor(
    targetPath: string,
    backupPath: string,
    replaceError: unknown,
    restoreError: unknown,
  ) {
    super(`atomic replace failed and backup restore failed (${targetPath})`, {
      cause: restoreError,
    });
    this.name = 'AtomicBackupRestoreFailedError';
    this.targetPath = targetPath;
    this.backupPath = backupPath;
    this.replaceError = replaceError;
  }
}

function isWindowsReplaceConflictCode(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

export async function replaceFileAtomically(
  tempPath: string,
  targetPath: string,
  renameLike: RenameLike = fs,
  validateBeforeCommit?: () => Promise<void>,
): Promise<void> {
  await validateBeforeCommit?.();
  try {
    await renameLike.rename(tempPath, targetPath);
    return;
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (!isWindowsReplaceConflictCode(code)) {
      throw error;
    }
  }

  await validateBeforeCommit?.();

  // The PID + UUID suffix keeps Windows fallback backups collision-resistant per replace attempt.
  const backupPath = `${targetPath}.${process.pid}.${randomUUID()}.bak`;
  let movedTargetToBackup = false;

  try {
    try {
      await renameLike.rename(targetPath, backupPath);
      movedTargetToBackup = true;
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await renameLike.rename(tempPath, targetPath);
    if (movedTargetToBackup) {
      try {
        await renameLike.unlink(backupPath);
      } catch (cleanupError: unknown) {
        if (!isNotFoundError(cleanupError)) {
          logger.warn('backup cleanup failed:', getErrorMessage(cleanupError));
        }
      }
    }
  } catch (error: unknown) {
    if (movedTargetToBackup) {
      try {
        await renameLike.rename(backupPath, targetPath);
      } catch (restoreError: unknown) {
        throw new AtomicBackupRestoreFailedError(
          targetPath,
          backupPath,
          error,
          restoreError,
        );
      }
    }
    if (isWindowsReplaceConflictCode(getErrorCode(error))) {
      throw new AtomicReplaceConflictError(targetPath);
    }
    throw error;
  }
}

export async function writeFileAtomically(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions & { encoding?: BufferEncoding } = {},
): Promise<void> {
  const {
    mode,
    atomicFs = fs,
    encoding = 'utf-8',
    validateBeforeCommit,
  } = options;
  await commitTemporaryFileAtomically(
    targetPath,
    (tempPath) =>
      atomicFs.writeFile(
        tempPath,
        content,
        typeof content === 'string'
          ? {
              encoding,
              ...(mode === undefined ? {} : { mode }),
            }
          : mode === undefined
            ? {}
            : { mode },
      ),
    atomicFs,
    validateBeforeCommit,
  );
}

export async function copyFileAtomically(
  sourcePath: string,
  targetPath: string,
  options: Pick<AtomicWriteOptions, 'validateBeforeCommit'> = {},
): Promise<void> {
  await commitTemporaryFileAtomically(
    targetPath,
    (tempPath) => fs.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL),
    fs,
    options.validateBeforeCommit,
  );
}

export async function writeTextFileAtomically(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomically(targetPath, content, {
    ...options,
    encoding: 'utf-8',
  });
}

async function commitTemporaryFileAtomically(
  targetPath: string,
  createTemporaryFile: (tempPath: string) => Promise<void>,
  atomicFs: AtomicReplaceLike,
  validateBeforeCommit?: () => Promise<void>,
): Promise<void> {
  await atomicFs.mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await createTemporaryFile(tempPath);
    await replaceFileAtomically(
      tempPath,
      targetPath,
      atomicFs,
      validateBeforeCommit,
    );
  } catch (error: unknown) {
    try {
      await atomicFs.unlink(tempPath);
    } catch (cleanupError: unknown) {
      if (!isNotFoundError(cleanupError)) {
        logger.warn('temp cleanup failed:', getErrorMessage(cleanupError));
      }
    }
    throw error;
  }
}
