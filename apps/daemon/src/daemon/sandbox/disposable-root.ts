import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
}): Promise<DisposableSandboxRoot> {
  const rootPath = await mkdtemp(
    join(options.parentDir ?? tmpdir(), `${options.attemptId}-`),
  );
  const homeDir = join(rootPath, 'home');
  const tempDir = join(rootPath, 'tmp');
  const outputDir = join(rootPath, 'out');
  await mkdir(homeDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

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
