import { sha256Hex } from '@geulbat/shared-utils/sha256';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isPathInsideWorkspaceBoundary } from '../files/normalize-path.js';
import type { SandboxOutputFileRef } from './attempt-store.js';

interface SandboxOutputBudget {
  maxFiles: number;
  maxBytes: number;
}

export interface CollectedSandboxOutput {
  rootPath: string;
  files: readonly SandboxOutputFileRef[];
  totalBytes: number;
}

export function isOpaqueSandboxOutputEvidenceRef(value: string): boolean {
  const prefix = 'sandbox-output:';
  if (!value.startsWith(prefix)) {
    return false;
  }
  const suffix = value.slice(prefix.length);
  if (suffix.length === 0) {
    return false;
  }
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  return (
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('.geulbat') &&
    !value.includes('..')
  );
}

export async function collectSandboxOutputRef(
  outputDir: string,
  budget?: SandboxOutputBudget,
): Promise<CollectedSandboxOutput> {
  const rootPath = await realpath(outputDir);
  const files: SandboxOutputFileRef[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const entryStats = await lstat(fullPath);

      if (entryStats.isSymbolicLink()) {
        const realTarget = await realpath(fullPath);
        if (!isPathInsideWorkspaceBoundary(rootPath, realTarget)) {
          throw new Error(
            `sandbox output escapes sandbox output directory: ${entry.name}`,
          );
        }
      }

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile() && !entryStats.isSymbolicLink()) {
        continue;
      }

      const realFilePath = await realpath(fullPath);
      if (!isPathInsideWorkspaceBoundary(rootPath, realFilePath)) {
        throw new Error(
          `sandbox output escapes sandbox output directory: ${entry.name}`,
        );
      }

      const fileStats = await stat(realFilePath);
      if (!fileStats.isFile()) {
        continue;
      }

      totalBytes += fileStats.size;
      if (budget !== undefined && totalBytes > budget.maxBytes) {
        throw new Error('sandbox output byte budget exceeded');
      }

      files.push({
        relativePath: relative(rootPath, realFilePath).split(sep).join('/'),
        bytes: fileStats.size,
        sha256: sha256Hex(await readFile(realFilePath)),
      });
      if (budget !== undefined && files.length > budget.maxFiles) {
        throw new Error('too many sandbox output files');
      }
    }
  }

  await visit(rootPath);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return { rootPath, files, totalBytes };
}
