import {
  createDelimitedFrameReader,
  streamHostRoutedCommandLines,
  type SearchFilesHostRouting,
} from './search-files-host-stream.js';
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
  options: {
    consistency?: 'filesystem_snapshot' | 'eventual_index';
    searchFilenameIndex?: typeof tryWindowsFilenameIndexSearch;
    /** 실행파일 탐색 주입 — 내용 검색은 rgPath를 인자로 받는데 여기만 내부에서 찾는다. */
    resolveRipgrepPathForRoot?: typeof resolveRipgrepPath;
    // P7.6 item 4 — 파일명 스캔과 Windows index query는 command-host 워커의
    // system 세션에서만 돈다. eventual-index 테스트처럼 명령을 실행하지 않는
    // injected query만 이 값 없이 끝날 수 있다.
    hostRouting?: SearchFilesHostRouting;
  } = {},
): Promise<SearchFilesResult> {
  const consistency = options.consistency ?? 'filesystem_snapshot';
  const results: SearchMatch[] = [];
  const acceptedRelativePaths = new Set<string>();
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
    if (acceptedRelativePaths.has(relativePath)) {
      return;
    }

    acceptedRelativePaths.add(relativePath);
    totalMatches += 1;
    const match = { path: relativePath, line: 0, text: '' };
    if (maxResults === undefined) {
      results.push(match);
      return;
    }
    insertBoundedSortedResult(results, match, maxResults);
  };

  if (consistency === 'eventual_index' && maxResults === undefined) {
    throw Object.assign(
      new Error('eventual_index filename search requires maxResults.'),
      { code: 'invalid_args' },
    );
  }
  if (consistency === 'eventual_index' && matchesInclude !== null) {
    throw Object.assign(
      new Error('eventual_index filename search does not accept include.'),
      { code: 'invalid_args' },
    );
  }

  const hostRouting = options.hostRouting;
  const indexedSearch = await (
    options.searchFilenameIndex ?? tryWindowsFilenameIndexSearch
  )({
    rootDir,
    pattern,
    ...(consistency === 'eventual_index' && maxResults !== undefined
      ? {
          queryMode: 'bounded_basename_glob' as const,
          maxResults,
        }
      : {}),
    ...(signal === undefined ? {} : { signal }),
    ...(hostRouting === undefined ? {} : { hostRouting }),
  });
  if (indexedSearch.kind === 'results') {
    for (const path of indexedSearch.paths) {
      acceptHostPath(path);
    }
  }

  if (consistency === 'eventual_index') {
    if (indexedSearch.kind === 'unavailable') {
      const code =
        indexedSearch.reasonCode === 'powershell_unavailable' ||
        indexedSearch.reasonCode === 'command_runtime_unavailable' ||
        indexedSearch.reasonCode === 'query_failed'
          ? 'execution_failed'
          : 'invalid_args';
      throw Object.assign(
        new Error(
          `Windows filename index is unavailable (${indexedSearch.reasonCode}).`,
        ),
        { code },
      );
    }
    return {
      backend: 'windows-search-index',
      consistency: 'eventual_index',
      query: 'filename',
      total: totalMatches,
      totalRelation: indexedSearch.limited ? 'lower_bound' : 'exact',
      truncated: indexedSearch.limited,
      results,
    };
  }

  const rgPath = await (
    options.resolveRipgrepPathForRoot ?? resolveRipgrepPath
  )(rootDir, hostRouting);
  const acceleration =
    indexedSearch.kind === 'unavailable' &&
    (indexedSearch.reasonCode === 'powershell_unavailable' ||
      indexedSearch.reasonCode === 'command_runtime_unavailable' ||
      indexedSearch.reasonCode === 'query_failed')
      ? {
          backend: 'windows-search-index' as const,
          status: 'unavailable' as const,
          reasonCode: indexedSearch.reasonCode,
        }
      : undefined;
  const rgArgs = [
    '--files',
    '--hidden',
    '--no-ignore',
    '--follow',
    '--null',
    '--',
    toRipgrepFsPath(rootDir, rgPath),
  ];
  const acceptPath = (ripgrepPath: string) => {
    if (ripgrepPath.length === 0) {
      return;
    }
    acceptHostPath(fromRipgrepFsPath(ripgrepPath, rgPath, workspaceRoot));
  };
  // 두 실행 경로가 같은 결과를 조립하도록 한 곳에 둔다.
  const buildFilenameResult = (): SearchFilesResult => {
    // An exact unbounded snapshot already retains every accepted path for
    // deduplication. Keep collection O(1) per match and sort once here;
    // inserting each path into the middle of a growing array turns broad
    // host searches into quadratic main-thread work.
    if (maxResults === undefined) {
      results.sort((left, right) => left.path.localeCompare(right.path));
    }
    return {
      backend:
        indexedSearch.kind === 'results'
          ? 'windows-search-index+ripgrep-files'
          : 'ripgrep-files',
      consistency:
        indexedSearch.kind === 'results'
          ? 'eventual_index'
          : 'filesystem_snapshot',
      ...(acceleration === undefined ? {} : { acceleration }),
      query: 'filename',
      total: totalMatches,
      truncated: maxResults !== undefined && totalMatches > results.length,
      results,
    };
  };

  if (hostRouting === undefined) {
    throw Object.assign(
      new Error(
        'search_files filename scans require the daemon host command runtime.',
      ),
      { code: 'execution_failed' },
    );
  }

  // ripgrep --files는 NUL로 경로를 구분한다 — 프레이밍만 다르고 스트림 경로는
  // 내용 검색과 같다.
  const frames = createDelimitedFrameReader('\u0000', acceptPath);
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: hostRouting.hostCommands,
    stateRoot: hostRouting.stateRoot,
    executable: rgPath,
    commandArgs: rgArgs,
    cwd: hostRouting.stateRoot,
    env: process.env,
    pageLimitBytes: hostRouting.pageLimitBytes,
    onStdoutChunk: frames.consume,
    ...(signal === undefined ? {} : { signal }),
  });
  frames.flush();
  if (!streamed.ok) {
    throw Object.assign(
      new Error(
        streamed.aborted
          ? 'ripgrep filename scan was cancelled'
          : `ripgrep filename session failed: ${streamed.message}`,
      ),
      { code: 'execution_failed' },
    );
  }
  const hostFailure = buildRipgrepCloseError({
    exitCode: streamed.value.exitCode,
    killed: streamed.value.status !== 'exit',
    stderr: streamed.value.stderr,
  });
  if (hostFailure) {
    throw hostFailure;
  }
  return buildFilenameResult();
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
  const pathPattern = effectivePattern.includes('/')
    ? effectivePattern
    : `**/${effectivePattern}`;
  const regexStr = globPatternToRegexSource(pathPattern);
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
  maxResults: number,
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
  if (low >= maxResults) {
    return;
  }
  results.splice(low, 0, match);
  if (results.length > maxResults) {
    results.pop();
  }
}
