import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { MemoryChunkRecord, MemoryManifest } from './types.js';
import { resolveDerivedArtifactTarget } from '../files/file-platform.js';
import { getErrorCode, getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';

const logger = createLogger('memory-index');

export function createGenerationId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

export async function writeIndexGeneration(
  stateRoot: string,
  manifest: MemoryManifest,
  records: MemoryChunkRecord[],
): Promise<void> {
  const [indexRoot, stagingRoot, previousRoot, memoryDir] = await Promise.all([
    resolveDerivedArtifactTarget(stateRoot, 'memory_index', 'index', {
      mode: 'mutate',
      allowMissingLeaf: true,
    }),
    resolveDerivedArtifactTarget(
      stateRoot,
      'memory_index',
      `.index-staging-${manifest.generationId}`,
      { mode: 'mutate', allowMissingLeaf: true },
    ),
    resolveDerivedArtifactTarget(
      stateRoot,
      'memory_index',
      `.index-previous-${manifest.generationId}`,
      { mode: 'mutate', allowMissingLeaf: true },
    ),
    resolveDerivedArtifactTarget(
      stateRoot,
      'memory_index',
      `.index-staging-${manifest.generationId}/memory`,
      { mode: 'mutate', allowMissingLeaf: true },
    ),
  ]);
  const geulbatRoot = dirname(indexRoot.absolutePath);

  await rm(stagingRoot.absolutePath, { recursive: true, force: true });
  await rm(previousRoot.absolutePath, { recursive: true, force: true });
  await mkdir(memoryDir.absolutePath, { recursive: true });

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const memoryJsonl = records
    .map((record) => JSON.stringify(record))
    .join('\n');

  await Promise.all([
    writeFile(
      join(stagingRoot.absolutePath, 'manifest.json'),
      manifestJson,
      'utf8',
    ),
    writeFile(
      join(memoryDir.absolutePath, 'all-memory.jsonl'),
      memoryJsonl.length > 0 ? `${memoryJsonl}\n` : '',
      'utf8',
    ),
  ]);

  await validateStagingGeneration(stagingRoot.absolutePath);

  let movedPrevious = false;
  try {
    await mkdir(geulbatRoot, { recursive: true });
    try {
      await rename(indexRoot.absolutePath, previousRoot.absolutePath);
      movedPrevious = true;
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    await rename(stagingRoot.absolutePath, indexRoot.absolutePath);

    if (movedPrevious) {
      await rm(previousRoot.absolutePath, { recursive: true, force: true });
    }
  } catch (error: unknown) {
    if (movedPrevious) {
      try {
        await rename(previousRoot.absolutePath, indexRoot.absolutePath);
      } catch (restoreError: unknown) {
        logger.warn(
          'failed to restore previous generation:',
          getErrorMessage(restoreError),
        );
      }
    }
    throw error;
  } finally {
    await rm(stagingRoot.absolutePath, { recursive: true, force: true });
  }
}

async function validateStagingGeneration(stagingRoot: string): Promise<void> {
  const manifestPath = join(stagingRoot, 'manifest.json');
  const memoryPath = join(stagingRoot, 'memory', 'all-memory.jsonl');

  const [manifestRaw, memoryRaw] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(memoryPath, 'utf8'),
  ]);

  JSON.parse(manifestRaw);
  for (const line of memoryRaw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    JSON.parse(line);
  }
}
