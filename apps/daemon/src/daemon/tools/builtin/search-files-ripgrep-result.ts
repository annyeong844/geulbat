import { isRecord, tryParseJsonRecord } from '../../runtime-json.js';
import type { SearchFilesResult, SearchMatch } from './search-files-shared.js';
import {
  fromRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';

export function parseRipgrepMatchLine(
  line: string,
  args: {
    rgPath: string;
    workspaceRoot: string;
  },
): SearchMatch | null {
  const { rgPath, workspaceRoot } = args;
  if (!line.trim()) {
    return null;
  }

  const parsedEvent = tryParseJsonRecord(line);
  if (!parsedEvent.ok) {
    return null;
  }

  const event = parsedEvent.value;
  if (event.type !== 'match' || !isRecord(event.data)) {
    return null;
  }

  const pathInfo = isRecord(event.data.path) ? event.data.path : null;
  const linesInfo = isRecord(event.data.lines) ? event.data.lines : null;
  const absPath = fromRipgrepFsPath(
    typeof pathInfo?.text === 'string' ? pathInfo.text : '',
    rgPath,
    workspaceRoot,
  );
  const relPath = toWorkspaceRelativeSearchPath(workspaceRoot, absPath);
  if (relPath === '') {
    return null;
  }

  return {
    path: relPath,
    line:
      typeof event.data.line_number === 'number' ? event.data.line_number : 0,
    text:
      typeof linesInfo?.text === 'string'
        ? linesInfo.text.replace(/\n$/, '')
        : '',
  };
}

export function buildRipgrepCloseError(args: {
  exitCode: number | null;
  killed: boolean;
  stderr: string;
}): Error | null {
  const { exitCode, killed, stderr } = args;
  if (
    exitCode !== null &&
    exitCode >= 2 &&
    !killed &&
    !hasOnlySymlinkCycleDiagnostics(stderr)
  ) {
    return Object.assign(
      new Error(`ripgrep error (exit ${exitCode}): ${stderr.slice(0, 200)}`),
      {
        code: 'execution_failed',
      },
    );
  }

  return null;
}

function hasOnlySymlinkCycleDiagnostics(stderr: string): boolean {
  const diagnostics = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    diagnostics.length > 0 &&
    diagnostics.every((line) => line.includes('File system loop found:'))
  );
}

export function buildRipgrepResult(
  query: string,
  totalMatches: number,
  results: SearchMatch[],
  maxResults: number | undefined,
): SearchFilesResult {
  return {
    backend: 'ripgrep',
    query,
    total: totalMatches,
    truncated: maxResults !== undefined && totalMatches > results.length,
    results,
  };
}
