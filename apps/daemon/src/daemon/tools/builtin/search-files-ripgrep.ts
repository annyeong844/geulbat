import { access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { getErrorMessage } from '../../utils/error.js';
import type { SearchFilesResult, SearchMatch } from './search-files-shared.js';
import {
  fromRipgrepFsPath,
  toRipgrepFsPath,
} from './search-files-ripgrep-paths.js';
import {
  createDelimitedFrameReader,
  streamHostRoutedCommandLines,
  type SearchFilesHostRouting,
} from './search-files-host-stream.js';
import {
  buildRipgrepCloseError,
  buildRipgrepResult,
  parseRipgrepMatchLine,
} from './search-files-ripgrep-result.js';

type RipgrepRootClass = 'posix' | 'wsl-drive' | 'windows';

const rgPathByRootClass = new Map<RipgrepRootClass, string>();

export async function resolveRipgrepPath(
  rootDir?: string,
  hostRouting?: SearchFilesHostRouting,
): Promise<string> {
  const rootClass = classifyRipgrepRoot(rootDir);
  const cachedPath = rgPathByRootClass.get(rootClass);
  if (cachedPath && isRipgrepBinaryCompatibleWithRoot(cachedPath, rootDir)) {
    return cachedPath;
  }
  const probeFailures: string[] = [];
  const require = createRequire(import.meta.url);

  for (const candidatePath of await listWindowsInteropRipgrepCandidatePaths(
    rootDir,
    probeFailures,
    hostRouting,
  )) {
    try {
      await access(candidatePath);
      rgPathByRootClass.set(rootClass, candidatePath);
      return candidatePath;
    } catch (error: unknown) {
      probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
    }
  }

  try {
    const rg: unknown = require('@vscode/ripgrep');
    if (
      typeof rg !== 'object' ||
      rg === null ||
      !('rgPath' in rg) ||
      typeof rg.rgPath !== 'string'
    ) {
      throw new TypeError('@vscode/ripgrep must export a string rgPath');
    }
    const candidatePaths = rg.rgPath.endsWith('.exe')
      ? [rg.rgPath]
      : [rg.rgPath, `${rg.rgPath}.exe`];

    for (const candidatePath of candidatePaths) {
      if (!isRipgrepBinaryCompatibleWithRoot(candidatePath, rootDir)) {
        probeFailures.push(`${candidatePath}: incompatible with ${rootDir}`);
        continue;
      }
      try {
        await access(candidatePath);
        rgPathByRootClass.set(rootClass, candidatePath);
        return candidatePath;
      } catch (error: unknown) {
        probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
      }
    }
  } catch (error: unknown) {
    probeFailures.push(
      `@vscode/ripgrep resolve failed: ${getErrorMessage(error)}`,
    );
  }

  for (const candidatePath of await listBundledRipgrepSiblingCandidatePaths(
    require,
    probeFailures,
  )) {
    if (!isRipgrepBinaryCompatibleWithRoot(candidatePath, rootDir)) {
      probeFailures.push(`${candidatePath}: incompatible with ${rootDir}`);
      continue;
    }
    try {
      await access(candidatePath);
      rgPathByRootClass.set(rootClass, candidatePath);
      return candidatePath;
    } catch (error: unknown) {
      probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
    }
  }

  for (const candidatePath of listSystemRipgrepCandidatePaths()) {
    try {
      await access(candidatePath);
      rgPathByRootClass.set(rootClass, candidatePath);
      return candidatePath;
    } catch (error: unknown) {
      probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
    }
  }

  const failureDetail =
    probeFailures.length > 0 ? ` Last probe: ${probeFailures[0]}.` : '';
  throw Object.assign(
    new Error(
      `search_files requires an accessible ripgrep binary. Run a normal npm ci with postinstall enabled or install rg on PATH.${failureDetail}`,
    ),
    { code: 'execution_failed' },
  );
}

function classifyRipgrepRoot(rootDir: string | undefined): RipgrepRootClass {
  if (/^\/mnt\/[a-z](\/|$)/iu.test(rootDir ?? '')) {
    return 'wsl-drive';
  }
  if (/^[a-z]:[\\/]/iu.test(rootDir ?? '') || process.platform === 'win32') {
    return 'windows';
  }
  return 'posix';
}

async function listWindowsInteropRipgrepCandidatePaths(
  rootDir: string | undefined,
  probeFailures: string[],
  hostRouting: SearchFilesHostRouting | undefined,
): Promise<string[]> {
  if (classifyRipgrepRoot(rootDir) !== 'wsl-drive' || rootDir === undefined) {
    return [];
  }
  const whereExecutable = '/mnt/c/Windows/System32/where.exe';
  try {
    await access(whereExecutable);
  } catch (error: unknown) {
    probeFailures.push(
      `Windows ripgrep discovery unavailable: ${getErrorMessage(error)}`,
    );
    return [];
  }

  if (hostRouting === undefined) {
    probeFailures.push(
      'Windows ripgrep discovery requires the daemon host command runtime',
    );
    return [];
  }
  const windowsPaths: string[] = [];
  const frames = createDelimitedFrameReader('\n', (line) => {
    const path = line.trim();
    if (path.length > 0) {
      windowsPaths.push(path);
    }
  });
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: hostRouting.hostCommands,
    stateRoot: hostRouting.stateRoot,
    executable: whereExecutable,
    commandArgs: ['rg.exe'],
    cwd: hostRouting.stateRoot,
    env: process.env,
    pageLimitBytes: hostRouting.pageLimitBytes,
    onStdoutChunk: frames.consume,
  });
  frames.flush();
  if (!streamed.ok || streamed.value.exitCode !== 0) {
    probeFailures.push(
      streamed.ok
        ? `Windows ripgrep discovery failed: ${streamed.value.stderr}`
        : `Windows ripgrep discovery failed: ${streamed.message}`,
    );
    return [];
  }
  return uniqueSorted(
    windowsPaths.map((path) => fromRipgrepFsPath(path, 'rg.exe', rootDir)),
  );
}

async function listBundledRipgrepSiblingCandidatePaths(
  require: ReturnType<typeof createRequire>,
  probeFailures: string[],
): Promise<string[]> {
  let scopeRoot: string;
  try {
    const ripgrepEntryPath = require.resolve('@vscode/ripgrep');
    scopeRoot = dirname(dirname(dirname(ripgrepEntryPath)));
  } catch (error: unknown) {
    probeFailures.push(
      `@vscode/ripgrep package root resolve failed: ${getErrorMessage(error)}`,
    );
    return [];
  }

  let packageDirectories: string[];
  try {
    const entries = await readdir(scopeRoot, { withFileTypes: true });
    packageDirectories = entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('ripgrep-'),
      )
      .map((entry) => entry.name);
  } catch (error: unknown) {
    probeFailures.push(`@vscode scope scan failed: ${getErrorMessage(error)}`);
    return [];
  }

  return packageDirectories
    .sort((left, right) => left.localeCompare(right))
    .flatMap((packageDirectory) => {
      const packageRoot = join(scopeRoot, packageDirectory);
      return [
        join(packageRoot, 'bin', 'rg'),
        join(packageRoot, 'bin', 'rg.exe'),
      ];
    });
}

function listSystemRipgrepCandidatePaths(): string[] {
  return uniqueSorted(
    (process.env.PATH ?? '')
      .split(delimiter)
      .filter((pathEntry) => pathEntry.length > 0 && isAbsolute(pathEntry))
      .flatMap((pathEntry) => [
        join(pathEntry, 'rg'),
        join(pathEntry, 'rg.exe'),
      ]),
  );
}

export function isRipgrepBinaryCompatibleWithRoot(
  rgPath: string,
  rootDir: string | undefined,
): boolean {
  if (rootDir === undefined) {
    return true;
  }
  const rootUsesNativeWindowsPath = /^[a-z]:[\\/]/iu.test(rootDir);
  const rootUsesWslDriveMount = /^\/mnt\/[a-z](\/|$)/iu.test(rootDir);
  const ripgrepIsWindowsExecutable = rgPath.toLowerCase().endsWith('.exe');
  if (!ripgrepIsWindowsExecutable) {
    return !rootUsesNativeWindowsPath;
  }
  return rootUsesNativeWindowsPath || rootUsesWslDriveMount;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildRipgrepSearchArgs(args: {
  rgPath: string;
  query: string;
  rootDir: string;
  glob: string | null;
}): string[] {
  return [
    '--json',
    '-j',
    '1',
    '--hidden',
    '--no-ignore',
    '--follow',
    ...(args.glob ? ['--glob', args.glob] : []),
    '--',
    args.query,
    toRipgrepFsPath(args.rootDir, args.rgPath),
  ];
}

/** 두 실행 경로가 같은 일치 판정을 쓰도록 누적을 한 곳에 둔다. */
function createRipgrepMatchCollector(args: {
  rgPath: string;
  workspaceRoot: string;
  maxResults: number | undefined;
}): {
  consumeLine: (line: string) => void;
  build: (query: string) => SearchFilesResult;
} {
  const results: SearchMatch[] = [];
  let totalMatches = 0;
  return {
    consumeLine(line) {
      const match = parseRipgrepMatchLine(line, {
        rgPath: args.rgPath,
        workspaceRoot: args.workspaceRoot,
      });
      if (!match) {
        return;
      }
      totalMatches += 1;
      if (args.maxResults === undefined || results.length < args.maxResults) {
        results.push(match);
      }
    },
    build(query) {
      return buildRipgrepResult(query, totalMatches, results, args.maxResults);
    },
  };
}

async function runHostRoutedRipgrep(args: {
  rgPath: string;
  rgArgs: string[];
  query: string;
  rootDir: string;
  workspaceRoot: string;
  maxResults: number | undefined;
  hostRouting: SearchFilesHostRouting;
  signal?: AbortSignal;
}): Promise<SearchFilesResult> {
  const collector = createRipgrepMatchCollector({
    rgPath: args.rgPath,
    workspaceRoot: args.workspaceRoot,
    maxResults: args.maxResults,
  });
  const frames = createDelimitedFrameReader('\n', collector.consumeLine);
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: args.hostRouting.hostCommands,
    stateRoot: args.hostRouting.stateRoot,
    executable: args.rgPath,
    commandArgs: args.rgArgs,
    // ripgrep은 검색 대상을 인자로 받으므로 cwd는 결과에 관여하지 않는다.
    cwd: args.hostRouting.stateRoot,
    env: process.env,
    pageLimitBytes: args.hostRouting.pageLimitBytes,
    onStdoutChunk: frames.consume,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  frames.flush();
  if (!streamed.ok) {
    throw Object.assign(
      new Error(
        streamed.aborted
          ? 'ripgrep search was cancelled'
          : `ripgrep session failed: ${streamed.message}`,
      ),
      {
        code: 'execution_failed',
        toolFailureDiagnostics: {
          phase: 'content_scan',
          reasonCode: streamed.aborted
            ? 'search_aborted'
            : 'search_command_runtime_failed',
          ...(streamed.aborted
            ? {}
            : {
                retryHint:
                  'Retry with a narrower path; if the failure repeats, check daemon command-host availability.',
              }),
        },
      },
    );
  }
  // 세션이 상한·취소로 자식을 끝낸 경우는 직접 실행의 killed와 같은 뜻이다 —
  // 그때의 비영점 종료는 검색 실패가 아니라 중단이므로 오류로 올리지 않는다.
  const failure = buildRipgrepCloseError({
    exitCode: streamed.value.exitCode,
    killed: streamed.value.status !== 'exit',
    stderr: streamed.value.stderr,
  });
  if (failure) {
    throw failure;
  }
  return collector.build(args.query);
}

export async function runRipgrep(
  rgPath: string,
  query: string,
  rootDir: string,
  glob: string | null,
  workspaceRoot: string,
  maxResults: number | undefined,
  signal: AbortSignal | undefined,
  // P7.6 item 4 — 검색 자식은 command-host 워커의 system 세션에서만 돈다.
  // runtime이 없는 호출은 데몬 직접 spawn으로 강등하지 않고 상위에서 fail-closed한다.
  hostRouting: SearchFilesHostRouting,
): Promise<SearchFilesResult> {
  const rgArgs = buildRipgrepSearchArgs({ rgPath, query, rootDir, glob });
  return await runHostRoutedRipgrep({
    rgPath,
    rgArgs,
    query,
    rootDir,
    workspaceRoot,
    maxResults,
    hostRouting,
    ...(signal === undefined ? {} : { signal }),
  });
}
