import {
  constants as fsConstants,
  copyFile,
  mkdir,
  readFile as fsReadFile,
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
  AlreadyExistsWriteTargetError,
  FileAccessError,
  MissingWriteTargetError,
  StaleWriteError,
} from './file-domain-error.js';

type SaveBinaryFileResult = FileSaveResponse;

/**
 * Binary save pipeline owner:
 * 1. resolve target
 * 2. serialize by absolute path
 * 3. validate exists / CAS state
 * 4. write bytes
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
    const versionToken = await createBinaryVersionTokenFromFile(inputPath);
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
): Promise<SaveBinaryFileResult> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return replaceResolvedBinaryFile(resolvedPath, content, expectedToken);
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
): Promise<SaveBinaryFileResult> {
  const {
    relativePath: normalized,
    absolutePath,
    canonicalAbsolutePath,
  } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    let currentContent: Uint8Array;
    try {
      currentContent = await fsReadFile(absolutePath);
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new MissingWriteTargetError(normalized, { cause: error });
      }
      if (hasErrorCode(error, 'EISDIR')) {
        throw FileAccessError.directoryPath(normalized);
      }
      throw error;
    }

    const currentToken = createBinaryVersionToken(currentContent);
    if (currentToken !== expectedToken) {
      throw new StaleWriteError(normalized, currentToken);
    }

    await fsWriteFile(absolutePath, content);
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
  const {
    relativePath: normalized,
    absolutePath,
    canonicalAbsolutePath,
  } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    let currentToken: string;
    try {
      currentToken = await createBinaryVersionTokenFromFile(absolutePath);
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

    const versionToken = await createBinaryVersionTokenFromFile(inputPath);
    await copyFile(inputPath, absolutePath);
    return {
      path: normalized,
      versionToken,
      totalLines: 0,
      ok: true,
    };
  });
}
