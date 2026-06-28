import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type CreateSandboxDirectory = (
  path: string,
  options: { recursive: true },
) => Promise<unknown> | unknown;

export interface DisposableSandboxRoot {
  rootPath: string;
  homeDir: string;
  tempDir: string;
  outputDir: string;
  cleanup(): Promise<void>;
}

export async function createDisposableSandboxRoot(options: {
  attemptId: string;
  parentDir?: string;
  createDirectory?: CreateSandboxDirectory;
}): Promise<DisposableSandboxRoot> {
  const rootPath = await mkdtemp(
    join(options.parentDir ?? tmpdir(), `${options.attemptId}-`),
  );
  const homeDir = join(rootPath, 'home');
  const tempDir = join(rootPath, 'tmp');
  const outputDir = join(rootPath, 'out');
  const createDirectory = options.createDirectory ?? mkdir;
  try {
    await createDirectory(homeDir, { recursive: true });
    await createDirectory(tempDir, { recursive: true });
    await createDirectory(outputDir, { recursive: true });
  } catch (error: unknown) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }

  return {
    rootPath,
    homeDir,
    tempDir,
    outputDir,
    cleanup() {
      return rm(rootPath, { recursive: true, force: true });
    },
  };
}
