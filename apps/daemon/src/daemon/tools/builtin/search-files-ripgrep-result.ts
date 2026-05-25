import { isRecord, tryParseJsonRecord } from '@geulbat/protocol/runtime-utils';
import type { SearchFilesResult, SearchMatch } from './search-files-shared.js';
import {
  fromRipgrepFsPath,
  isWorkspaceRelativeSearchPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';

const MAX_MATCH_LINE_TEXT_PREVIEW_LENGTH = 300;

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
  if (!isWorkspaceRelativeSearchPath(relPath)) {
    return null;
  }

  return {
    path: relPath,
    line:
      typeof event.data.line_number === 'number' ? event.data.line_number : 0,
    text:
      typeof linesInfo?.text === 'string'
        ? linesInfo.text
            .replace(/\n$/, '')
            .slice(0, MAX_MATCH_LINE_TEXT_PREVIEW_LENGTH)
        : '',
  };
}

export function buildRipgrepCloseError(args: {
  exitCode: number | null;
  killed: boolean;
  stderr: string;
  totalBytes: number;
  maxBufferBytes: number;
}): Error | null {
  const { exitCode, killed, stderr, totalBytes, maxBufferBytes } = args;
  if (exitCode !== null && exitCode >= 2 && !killed) {
    return Object.assign(
      new Error(`ripgrep error (exit ${exitCode}): ${stderr.slice(0, 200)}`),
      {
        code: 'execution_failed',
      },
    );
  }

  if (totalBytes > maxBufferBytes) {
    return Object.assign(
      new Error(
        `Search results exceeded ${maxBufferBytes / 1_000_000}MB buffer limit.`,
      ),
      {
        code: 'buffer_limit_exceeded',
      },
    );
  }

  return null;
}

export function buildRipgrepResult(
  query: string,
  totalMatches: number,
  results: SearchMatch[],
  maxResults: number,
): SearchFilesResult {
  return {
    backend: 'ripgrep',
    query,
    total: totalMatches,
    truncated: results.length >= maxResults,
    results,
  };
}
