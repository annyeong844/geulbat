import {
  GEULBAT_INTERNAL_EXCLUDE_GLOB,
  GEULBAT_INTERNAL_ROOT,
} from './geulbat-internal-paths.js';

const RESERVED_PATHS = new Set([
  GEULBAT_INTERNAL_ROOT,
  '.git',
  '.env',
  '.envrc',
  '.npmrc',
  '.yarnrc.yml',
]);

const EXCLUDED_WORKSPACE_ENTRY_NAMES = new Set([
  GEULBAT_INTERNAL_ROOT,
  '.git',
  'node_modules',
]);

const EXCLUDED_CONTENT_SEARCH_GLOBS = [
  '!.git/',
  '!**/.git/**',
  GEULBAT_INTERNAL_EXCLUDE_GLOB,
  `!**/${GEULBAT_INTERNAL_ROOT}/**`,
  '!node_modules/',
  '!**/node_modules/**',
  '!.env',
  '!**/.env',
  '!.env.*',
  '!**/.env.*',
  '!.envrc',
  '!**/.envrc',
  '!.npmrc',
  '!**/.npmrc',
  '!.yarnrc.yml',
  '!**/.yarnrc.yml',
] as const;

export function isReservedPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .map(normalizeReservedPathToken)
    .some(
      (segment) => RESERVED_PATHS.has(segment) || segment.startsWith('.env.'),
    );
}

export function shouldExcludeWorkspaceEntry(
  relativePath: string,
  entryName: string,
): boolean {
  return (
    isReservedPath(relativePath) ||
    EXCLUDED_WORKSPACE_ENTRY_NAMES.has(normalizeReservedPathToken(entryName))
  );
}

export function getExcludedContentSearchGlobs(): readonly string[] {
  return EXCLUDED_CONTENT_SEARCH_GLOBS;
}

function normalizeReservedPathToken(value: string): string {
  // Reserved workspace names are ASCII-only; locale-sensitive case folding
  // would incorrectly vary across environments (for example Turkish `I`).
  return value.toLowerCase();
}
