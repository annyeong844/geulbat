import { readFile as fsReadFile } from 'node:fs/promises';
import type { FileSaveResponse } from './contract.js';
import {
  resolveSourceMutationTarget,
  type SourceMutationTarget,
  writeAtomically,
} from './file-platform.js';
import { countTextLines, normalizeTextContent } from './text-content.js';
import { createVersionToken } from './version-token.js';
import { hasErrorCode } from '../utils/error.js';
import {
  AtomicReplaceConflictError,
  type AtomicWriteLike,
} from '../utils/atomic-file.js';
import { runSourceMutationSerial } from './file-mutation-serial.js';
import {
  FileAccessError,
  MissingWriteTargetError,
  StaleWriteError,
} from './file-domain-error.js';
import { officeTextKindOf } from './office-text-extract.js';

export type SaveFileResult = FileSaveResponse;

export interface SaveFileOptions {
  atomicFs?: AtomicWriteLike;
}

/**
 * Save pipeline owner:
 * 1. resolve target
 * 2. serialize by absolute path
 * 3. validate CAS / exists state
 *    - empty expectedToken is a create-only sentinel
 * 4. write atomically
 * 5. compute version token + result
 */
export async function saveFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
  expectedToken: string,
  options?: SaveFileOptions,
): Promise<SaveFileResult> {
  // 오피스 문서는 추출 텍스트로만 열린다 — 텍스트 저장이 원본 바이너리를
  // 덮어쓰면 문서가 파괴되므로 명시적으로 거부한다.
  if (officeTextKindOf(relativePath) !== null) {
    throw new FileAccessError(
      'access_denied',
      `office document is read-only (extracted view): ${relativePath}`,
      relativePath,
    );
  }
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: true,
    },
  );
  return saveResolvedFile(resolvedPath, content, expectedToken, options);
}

export async function saveResolvedFile(
  resolvedPath: SourceMutationTarget,
  content: string,
  expectedToken: string,
  options?: SaveFileOptions,
): Promise<SaveFileResult> {
  const {
    relativePath: normalized,
    absolutePath,
    canonicalAbsolutePath,
  } = resolvedPath;
  return runSourceMutationSerial(canonicalAbsolutePath, async () => {
    const normalizedExpectedToken = expectedToken.trim();
    let currentToken: string | null = null;
    try {
      const buf = await fsReadFile(absolutePath);
      const currentContent = normalizeTextContent(buf.toString('utf8'));
      currentToken = createVersionToken(currentContent);
    } catch (err: unknown) {
      if (!hasErrorCode(err, 'ENOENT')) {
        throw err;
      }
      if (normalizedExpectedToken.length > 0) {
        throw new MissingWriteTargetError(normalized, { cause: err });
      }
    }

    if (currentToken !== null && currentToken !== normalizedExpectedToken) {
      throw new StaleWriteError(normalized, currentToken);
    }

    const canonical = normalizeTextContent(content);

    try {
      await writeAtomically(
        resolvedPath,
        canonical,
        options?.atomicFs !== undefined ? { atomicFs: options.atomicFs } : {},
      );
    } catch (error: unknown) {
      if (error instanceof AtomicReplaceConflictError) {
        const conflictToken = await readCurrentVersionToken(absolutePath);
        if (conflictToken !== null) {
          throw new StaleWriteError(normalized, conflictToken);
        }
      }
      throw error;
    }

    const newToken = createVersionToken(canonical);
    const totalLines = countTextLines(canonical);

    return { path: normalized, versionToken: newToken, totalLines, ok: true };
  });
}

async function readCurrentVersionToken(
  absolutePath: string,
): Promise<string | null> {
  try {
    const buf = await fsReadFile(absolutePath);
    const currentContent = normalizeTextContent(buf.toString('utf8'));
    return createVersionToken(currentContent);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}
