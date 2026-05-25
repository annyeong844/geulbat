import { join } from 'node:path';

export const GEULBAT_INTERNAL_ROOT = '.geulbat';
export const GEULBAT_INTERNAL_EXCLUDE_GLOB = `!${GEULBAT_INTERNAL_ROOT}/`;

export const GEULBAT_INDEX_ROOT = `${GEULBAT_INTERNAL_ROOT}/index`;
const GEULBAT_MEMORY_INDEX_ROOT = `${GEULBAT_INDEX_ROOT}/memory`;
export const GEULBAT_MEMORY_MANIFEST_PATH = `${GEULBAT_INDEX_ROOT}/manifest.json`;
export const GEULBAT_MEMORY_INDEX_RECORDS_PATH = `${GEULBAT_MEMORY_INDEX_ROOT}/all-memory.jsonl`;

export const GEULBAT_RUNTIME_PERSISTENCE_ROOT = `${GEULBAT_INTERNAL_ROOT}/runtime-persistence`;

export function joinWorkspaceGeulbatPath(
  workspaceRoot: string,
  ...segments: string[]
): string {
  return join(workspaceRoot, GEULBAT_INTERNAL_ROOT, ...segments);
}

export function buildGeulbatRelativePath(...segments: string[]): string {
  if (segments.length === 0) {
    return GEULBAT_INTERNAL_ROOT;
  }
  return `${GEULBAT_INTERNAL_ROOT}/${segments.join('/')}`;
}
