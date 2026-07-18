import { GEULBAT_INTERNAL_ROOT } from './geulbat-internal-paths.js';

const MEMORY_EXCLUDED_PATH_SEGMENTS = new Set([
  GEULBAT_INTERNAL_ROOT,
  '.git',
  '.env',
  '.envrc',
  '.npmrc',
  '.yarnrc.yml',
]);

const MEMORY_EXCLUDED_ENTRY_NAMES = new Set([
  GEULBAT_INTERNAL_ROOT,
  '.git',
  'node_modules',
]);

function hasMemoryExcludedPathSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .map(normalizeExcludedPathToken)
    .some(
      (segment) =>
        MEMORY_EXCLUDED_PATH_SEGMENTS.has(segment) ||
        segment.startsWith('.env.'),
    );
}

export function shouldExcludeMemorySourceEntry(
  relativePath: string,
  entryName: string,
): boolean {
  return (
    hasMemoryExcludedPathSegment(relativePath) ||
    MEMORY_EXCLUDED_ENTRY_NAMES.has(normalizeExcludedPathToken(entryName))
  );
}

function normalizeExcludedPathToken(value: string): string {
  // Excluded names are ASCII-only; locale-sensitive case folding
  // would incorrectly vary across environments (for example Turkish `I`).
  return value.toLowerCase();
}
