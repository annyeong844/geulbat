import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

export async function resolveRipgrepPath(): Promise<string> {
  if (_rgPath) return _rgPath;
  const probeFailures: string[] = [];

  try {
    const require = createRequire(import.meta.url);
    const rg = require('@vscode/ripgrep') as { rgPath: string };
    const candidatePaths = rg.rgPath.endsWith('.exe')
      ? [rg.rgPath]
      : [rg.rgPath, `${rg.rgPath}.exe`];

    for (const candidatePath of candidatePaths) {
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

  const failureDetail =
    probeFailures.length > 0 ? ` Last probe: ${probeFailures[0]}.` : '';
  throw Object.assign(
    new Error(
      `search_files requires the bundled @vscode/ripgrep binary for content search. Run a normal npm ci with postinstall enabled.${failureDetail}`,
    ),
    { code: 'execution_failed' },
  );
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
        '--glob',
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
