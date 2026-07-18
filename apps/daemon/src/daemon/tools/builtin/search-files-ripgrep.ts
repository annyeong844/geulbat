import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { getExcludedContentSearchGlobs } from '../../files/reserved-paths.js';
import { getErrorMessage } from '../../utils/error.js';
import type { SearchFilesResult, SearchMatch } from './search-files-shared.js';
import { toRipgrepFsPath } from './search-files-ripgrep-paths.js';
import {
  buildRipgrepCloseError,
  buildRipgrepResult,
  parseRipgrepMatchLine,
} from './search-files-ripgrep-result.js';

let _rgPath: string | undefined;

export async function resolveRipgrepPath(rootDir?: string): Promise<string> {
  if (_rgPath && isRipgrepBinaryCompatibleWithRoot(_rgPath, rootDir)) {
    return _rgPath;
  }
  const probeFailures: string[] = [];
  const require = createRequire(import.meta.url);

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
        _rgPath = candidatePath;
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
      _rgPath = candidatePath;
      return candidatePath;
    } catch (error: unknown) {
      probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
    }
  }

  for (const candidatePath of listSystemRipgrepCandidatePaths()) {
    try {
      await access(candidatePath);
      _rgPath = candidatePath;
      return candidatePath;
    } catch (error: unknown) {
      probeFailures.push(`${candidatePath}: ${getErrorMessage(error)}`);
    }
  }

  const failureDetail =
    probeFailures.length > 0 ? ` Last probe: ${probeFailures[0]}.` : '';
  throw Object.assign(
    new Error(
      `search_files requires an accessible ripgrep binary for content search. Run a normal npm ci with postinstall enabled or install rg on PATH.${failureDetail}`,
    ),
    { code: 'execution_failed' },
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

export async function runRipgrep(
  rgPath: string,
  query: string,
  rootDir: string,
  glob: string | null,
  workspaceRoot: string,
  maxResults: number | undefined,
  signal?: AbortSignal,
): Promise<SearchFilesResult> {
  return new Promise((resolve, reject) => {
    const rgRootDir = toRipgrepFsPath(rootDir, rgPath);
    const rgArgs = [
      '--json',
      '--fixed-strings',
      '-j',
      '1',
      ...(glob ? ['--glob', glob] : []),
      ...getExcludedContentSearchGlobs().flatMap((excludedGlob) => [
        '--iglob',
        excludedGlob,
      ]),
      '--',
      query,
      rgRootDir,
    ];

    const results: SearchMatch[] = [];
    let totalMatches = 0;
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
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const match = parseRipgrepMatchLine(line, {
          rgPath,
          workspaceRoot,
        });
        if (!match) {
          continue;
        }

        totalMatches += 1;
        if (maxResults === undefined || results.length < maxResults) {
          results.push(match);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', killChild);
      const failure = buildRipgrepCloseError({
        exitCode,
        killed,
        stderr,
      });
      if (failure) {
        reject(failure);
        return;
      }

      resolve(buildRipgrepResult(query, totalMatches, results, maxResults));
    });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', killChild);
      reject(
        Object.assign(new Error(`ripgrep spawn failed: ${err.message}`), {
          code: 'execution_failed',
        }),
      );
    });
  });
}
