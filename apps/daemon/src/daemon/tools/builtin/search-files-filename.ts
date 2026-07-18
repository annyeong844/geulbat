import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { shouldExcludeWorkspaceEntry } from '../../files/reserved-paths.js';
import { getErrorCode } from '../../utils/error.js';
import type {
  SearchFilesResult,
  SearchMatch,
  SearchPathMatcher,
} from './search-files-shared.js';

interface FilenameSearchDependencies {
  readdir: typeof readdir;
}

export async function filenameSearch(
  rootDir: string,
  workspaceRoot: string,
  matchesPattern: SearchPathMatcher,
  matchesInclude: SearchPathMatcher,
  maxResults: number | undefined,
  dependencies?: Partial<FilenameSearchDependencies>,
): Promise<SearchFilesResult> {
  const results: SearchMatch[] = [];
  const counter = { total: 0 };
  const resolvedDependencies: FilenameSearchDependencies = {
    readdir,
    ...dependencies,
  };
  await walkAndCollectFilenames(
    rootDir,
    workspaceRoot,
    matchesPattern,
    matchesInclude,
    results,
    counter,
    maxResults,
    resolvedDependencies,
  );
  const truncated = maxResults !== undefined && counter.total > results.length;
  return {
    backend: 'js-filename',
    query: 'filename',
    total: counter.total,
    truncated,
    results,
  };
}

export function createGlobMatcher(pattern: string | null): SearchPathMatcher {
  if (!pattern) {
    return null;
  }
  const regexStr = globPatternToRegexSource(pattern);
  const regex = new RegExp(`^${regexStr}$`);
  return (filePath: string) => regex.test(filePath);
}

function globPatternToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === undefined) {
      break;
    }
    const nextCharacter = pattern[index + 1];
    const nextNextCharacter = pattern[index + 2];

    if (
      character === '*' &&
      nextCharacter === '*' &&
      nextNextCharacter === '/'
    ) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (character === '*' && nextCharacter === '*') {
      source += '.*';
      index += 2;
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeRegexCharacter(character);
    index += 1;
  }
  return source;
}

function escapeRegexCharacter(character: string): string {
  return /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

async function walkAndCollectFilenames(
  dir: string,
  root: string,
  matchesPattern: SearchPathMatcher,
  matchesInclude: SearchPathMatcher,
  results: SearchMatch[],
  counter: { total: number },
  maxResults: number | undefined,
  dependencies: FilenameSearchDependencies,
): Promise<void> {
  let entries;
  try {
    entries = await dependencies.readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return;
    }
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(root, fullPath).split(sep).join('/');

    if (shouldExcludeWorkspaceEntry(relativePath, entry.name)) {
      continue;
    }

    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await walkAndCollectFilenames(
        fullPath,
        root,
        matchesPattern,
        matchesInclude,
        results,
        counter,
        maxResults,
        dependencies,
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (matchesInclude && !matchesInclude(relativePath)) {
      continue;
    }
    if (matchesPattern && !matchesPattern(relativePath)) {
      continue;
    }

    counter.total++;
    if (maxResults === undefined || results.length < maxResults) {
      results.push({ path: relativePath, line: 0, text: '' });
    }
  }
}
