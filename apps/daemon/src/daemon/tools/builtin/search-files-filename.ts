import { spawn } from 'node:child_process';
import type {
  SearchFilesResult,
  SearchMatch,
  SearchPathMatcher,
} from './search-files-shared.js';
import {
  fromRipgrepFsPath,
  toRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';
import { buildRipgrepCloseError } from './search-files-ripgrep-result.js';
import { resolveRipgrepPath } from './search-files-ripgrep.js';
import { tryWindowsFilenameIndexSearch } from './search-files-windows-index.js';

export async function filenameSearch(
  rootDir: string,
  workspaceRoot: string,
  pattern: string,
  matchesPattern: SearchPathMatcher,
  matchesInclude: SearchPathMatcher,
  maxResults: number | undefined,
  signal?: AbortSignal,
): Promise<SearchFilesResult> {
  const results: SearchMatch[] = [];
  let totalMatches = 0;
  const acceptHostPath = (hostPath: string) => {
    const rootRelativePath = toWorkspaceRelativeSearchPath(rootDir, hostPath);
    if (
      rootRelativePath === '..' ||
      rootRelativePath.startsWith('../') ||
      /^[a-z]:\//iu.test(rootRelativePath)
    ) {
      return;
    }
    const relativePath = toWorkspaceRelativeSearchPath(workspaceRoot, hostPath);
    if (matchesInclude && !matchesInclude(relativePath)) {
      return;
    }
    if (matchesPattern && !matchesPattern(relativePath)) {
      return;
    }

    totalMatches += 1;
    insertBoundedSortedResult(
      results,
      { path: relativePath, line: 0, text: '' },
      maxResults,
    );
  };

  const indexedSearch = await tryWindowsFilenameIndexSearch({
    rootDir,
    pattern,
    ...(signal === undefined ? {} : { signal }),
  });
  if (indexedSearch.kind === 'results') {
    for (const path of indexedSearch.paths) {
      acceptHostPath(path);
    }
    return {
      backend: 'windows-search-index',
      consistency: 'eventual_index',
      query: 'filename',
      total: totalMatches,
      truncated: maxResults !== undefined && totalMatches > results.length,
      results,
    };
  }

  const rgPath = await resolveRipgrepPath(rootDir);
  const acceleration =
    indexedSearch.reasonCode === 'powershell_unavailable' ||
    indexedSearch.reasonCode === 'query_failed'
      ? {
          backend: 'windows-search-index' as const,
          status: 'unavailable' as const,
          reasonCode: indexedSearch.reasonCode,
        }
      : undefined;
  return await new Promise((resolve, reject) => {
    const rgRootDir = toRipgrepFsPath(rootDir, rgPath);
    const rgArgs = [
      '--files',
      '--hidden',
      '--no-ignore',
      '--follow',
      '--null',
      '--',
      rgRootDir,
    ];
    let buffer = '';
    let stderr = '';
    let killed = false;

    const child = spawn(rgPath, rgArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const killChild = () => {
      if (!killed) {
        killed = true;
        child.kill('SIGTERM');
      }
    };
    const acceptPath = (ripgrepPath: string) => {
      if (ripgrepPath.length === 0) {
        return;
      }
      const hostPath = fromRipgrepFsPath(ripgrepPath, rgPath, workspaceRoot);
      acceptHostPath(hostPath);
    };

    if (signal) {
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener('abort', killChild, { once: true });
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const paths = buffer.split('\0');
      buffer = paths.pop() ?? '';
      for (const path of paths) {
        acceptPath(path);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', killChild);
      acceptPath(buffer);
      const failure = buildRipgrepCloseError({ exitCode, killed, stderr });
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        backend: 'ripgrep-files',
        consistency: 'filesystem_snapshot',
        ...(acceleration === undefined ? {} : { acceleration }),
        query: 'filename',
        total: totalMatches,
        truncated: maxResults !== undefined && totalMatches > results.length,
        results,
      });
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', killChild);
      reject(
        Object.assign(
          new Error(`ripgrep filename scan failed: ${error.message}`),
          { code: 'execution_failed' },
        ),
      );
    });
  });
}

export function createGlobMatcher(pattern: string | null): SearchPathMatcher {
  if (!pattern) {
    return null;
  }
  const excludesMatches = pattern.startsWith('!');
  const effectivePattern = excludesMatches ? pattern.slice(1) : pattern;
  if (!effectivePattern) {
    return null;
  }
  const regexStr = globPatternToRegexSource(effectivePattern);
  const regex = new RegExp(`^${regexStr}$`);
  return excludesMatches
    ? (filePath: string) => !regex.test(filePath)
    : (filePath: string) => regex.test(filePath);
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

function insertBoundedSortedResult(
  results: SearchMatch[],
  match: SearchMatch,
  maxResults: number | undefined,
): void {
  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (results[middle]!.path.localeCompare(match.path) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (maxResults !== undefined && low >= maxResults) {
    return;
  }
  results.splice(low, 0, match);
  if (maxResults !== undefined && results.length > maxResults) {
    results.pop();
  }
}
