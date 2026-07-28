import {
  constants as fsConstants,
  copyFile,
  mkdir,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSaveResponse } from './contract.js';
import {
  resolveSourceMutationTarget,
  type SourceMutationTarget,
} from './file-platform.js';
import {
  createBinaryVersionToken,
  createBinaryVersionTokenFromFile,
} from './version-token.js';
import { runSourceMutationSerial } from './file-mutation-serial.js';
import { hasErrorCode } from '../utils/error.js';
import {
  AtomicReplaceConflictError,
  copyFileAtomically,
  type AtomicWriteLike,
  writeFileAtomically,
} from '../utils/atomic-file.js';
import {
  AlreadyExistsWriteTargetError,
  FileAccessError,
  MissingWriteTargetError,
  StaleWriteError,
} from './file-domain-error.js';

type SaveBinaryFileResult = FileSaveResponse;

interface ReplaceBinaryFileOptions {
  atomicFs?: AtomicWriteLike;
}

/**
 * Binary save pipeline owner:
 * 1. resolve target
 * 2. serialize by canonical target path
 * 3. validate exists / CAS state
 * 4. create exclusively or replace atomically
 * 5. compute version token + result
 */
export async function saveBinaryFile(
  workspaceRoot: string,
  relativePath: string,
  content: Uint8Array,
): Promise<SaveBinaryFileResult> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return saveResolvedBinaryFile(resolvedPath, content);
}

export async function saveBinaryFileFromPath(
  workspaceRoot: string,
  relativePath: string,
  inputPath: string,
): Promise<SaveBinaryFileResult> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return saveResolvedBinaryFileFromPath(resolvedPath, inputPath);
}

async function saveResolvedBinaryFile(
  resolvedPath: SourceMutationTarget,
  content: Uint8Array,
): Promise<SaveBinaryFileResult> {
  const {
    relativePath: normalized,
    absolutePath,
    canonicalAbsolutePath,
  } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await fsWriteFile(absolutePath, content, { flag: 'wx' });
    } catch (error: unknown) {
      if (
        hasErrorCode(error, 'EEXIST') ||
        hasErrorCode(error, 'EISDIR') ||
        hasErrorCode(error, 'EPERM')
      ) {
        throw new AlreadyExistsWriteTargetError(normalized);
      }
      throw error;
    }

    return {
      path: normalized,
      versionToken: createBinaryVersionToken(content),
      totalLines: 0,
      ok: true,
    };
  });
}

async function saveResolvedBinaryFileFromPath(
  resolvedPath: SourceMutationTarget,
  inputPath: string,
): Promise<SaveBinaryFileResult> {
  const {
    relativePath: normalized,
    absolutePath,
    canonicalAbsolutePath,
  } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await copyFile(inputPath, absolutePath, fsConstants.COPYFILE_EXCL);
    } catch (error: unknown) {
      if (
        hasErrorCode(error, 'EEXIST') ||
        hasErrorCode(error, 'EISDIR') ||
        hasErrorCode(error, 'EPERM')
      ) {
        throw new AlreadyExistsWriteTargetError(normalized);
      }
      throw error;
    }
    const versionToken = await createBinaryVersionTokenFromFile(
      canonicalAbsolutePath,
    );

    return {
      path: normalized,
      versionToken,
      totalLines: 0,
      ok: true,
    };
  });
}

export async function replaceBinaryFile(
  workspaceRoot: string,
  relativePath: string,
  content: Uint8Array,
  expectedToken: string,
  options?: ReplaceBinaryFileOptions,
): Promise<SaveBinaryFileResult> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return replaceResolvedBinaryFile(
    resolvedPath,
    content,
    expectedToken,
    options,
  );
}

export async function replaceBinaryFileFromPath(
  workspaceRoot: string,
  relativePath: string,
  inputPath: string,
  expectedToken: string,
): Promise<SaveBinaryFileResult> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return replaceResolvedBinaryFileFromPath(
    resolvedPath,
    inputPath,
    expectedToken,
  );
}

async function replaceResolvedBinaryFile(
  resolvedPath: SourceMutationTarget,
  content: Uint8Array,
  expectedToken: string,
  options?: ReplaceBinaryFileOptions,
): Promise<SaveBinaryFileResult> {
  const { relativePath: normalized, canonicalAbsolutePath } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    let currentToken: string;
    try {
      currentToken = await createBinaryVersionTokenFromFile(
        canonicalAbsolutePath,
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new MissingWriteTargetError(normalized, { cause: error });
      }
      if (hasErrorCode(error, 'EISDIR')) {
        throw FileAccessError.directoryPath(normalized);
      }
      throw error;
    }

    if (currentToken !== expectedToken) {
      throw new StaleWriteError(normalized, currentToken);
    }

    try {
      await writeFileAtomically(canonicalAbsolutePath, content, {
        atomicFs: options?.atomicFs,
        validateBeforeCommit: () =>
          assertBinaryVersionUnchangedBeforeCommit(
            canonicalAbsolutePath,
            normalized,
            currentToken,
          ),
      });
    } catch (error: unknown) {
      if (error instanceof AtomicReplaceConflictError) {
        const conflictToken = await readCurrentBinaryVersionToken(
          canonicalAbsolutePath,
        );
        if (conflictToken !== null) {
          throw new StaleWriteError(normalized, conflictToken);
        }
      }
      throw error;
    }

    return {
      path: normalized,
      versionToken: createBinaryVersionToken(content),
      totalLines: 0,
      ok: true,
    };
  });
}

async function replaceResolvedBinaryFileFromPath(
  resolvedPath: SourceMutationTarget,
  inputPath: string,
  expectedToken: string,
): Promise<SaveBinaryFileResult> {
  const { relativePath: normalized, canonicalAbsolutePath } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    let currentToken: string;
    try {
      currentToken = await createBinaryVersionTokenFromFile(
        canonicalAbsolutePath,
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new MissingWriteTargetError(normalized, { cause: error });
      }
      if (hasErrorCode(error, 'EISDIR')) {
        throw FileAccessError.directoryPath(normalized);
      }
      throw error;
    }

    if (currentToken !== expectedToken) {
      throw new StaleWriteError(normalized, currentToken);
    }

    try {
      await copyFileAtomically(inputPath, canonicalAbsolutePath, {
        validateBeforeCommit: () =>
          assertBinaryVersionUnchangedBeforeCommit(
            canonicalAbsolutePath,
            normalized,
            currentToken,
          ),
      });
    } catch (error: unknown) {
      if (error instanceof AtomicReplaceConflictError) {
        const conflictToken = await readCurrentBinaryVersionToken(
          canonicalAbsolutePath,
        );
        if (conflictToken !== null) {
          throw new StaleWriteError(normalized, conflictToken);
        }
      }
      throw error;
    }
    const versionToken = await createBinaryVersionTokenFromFile(
      canonicalAbsolutePath,
    );
    return {
      path: normalized,
      versionToken,
      totalLines: 0,
      ok: true,
    };
  });
}

async function readCurrentBinaryVersionToken(
  canonicalAbsolutePath: string,
): Promise<string | null> {
  try {
    return await createBinaryVersionTokenFromFile(canonicalAbsolutePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function assertBinaryVersionUnchangedBeforeCommit(
  canonicalAbsolutePath: string,
  normalizedPath: string,
  expectedCurrentToken: string,
): Promise<void> {
  const commitToken = await readCurrentBinaryVersionToken(
    canonicalAbsolutePath,
  );
  if (commitToken === expectedCurrentToken) {
    return;
  }
  if (commitToken === null) {
    throw new MissingWriteTargetError(normalizedPath);
  }
  throw new StaleWriteError(normalizedPath, commitToken);
}
