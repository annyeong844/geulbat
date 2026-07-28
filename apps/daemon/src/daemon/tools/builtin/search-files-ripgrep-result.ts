import { isRecord, tryParseJsonRecord } from '../../runtime-json.js';
import type { SearchFilesResult, SearchMatch } from './search-files-shared.js';
import {
  fromRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';

const MATCH_PREVIEW_MAX_BYTES_ENV =
  'GEULBAT_SEARCH_FILES_MATCH_PREVIEW_MAX_BYTES';
const DEFAULT_MATCH_PREVIEW_MAX_BYTES = 2000;
const MATCH_PREVIEW_TRUNCATION_SUFFIX = '... [truncated]';

interface SearchMatchPreviewEnv {
  GEULBAT_SEARCH_FILES_MATCH_PREVIEW_MAX_BYTES?: string | undefined;
}

/**
 * 매치 미리보기 바이트 상한. 기본값은 검색 결과를 locator로 쓰기에 충분하고,
 * 한 줄짜리 생성 파일이 durable 출력을 지배하지 않도록 막는다.
 *
 * 잘못된 설정은 조용히 기본값으로 되돌리지 않는다. 운영자가 상한을 지정했다고
 * 믿는 동안 다른 값이 쓰이면 그것을 알 방법이 없다.
 */
export function resolveSearchMatchPreviewMaxBytes(
  env: SearchMatchPreviewEnv,
): number {
  const raw = env[MATCH_PREVIEW_MAX_BYTES_ENV];
  if (raw === undefined) {
    return DEFAULT_MATCH_PREVIEW_MAX_BYTES;
  }
  const value = raw.trim();
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(
      `invalid ${MATCH_PREVIEW_MAX_BYTES_ENV}: expected a positive integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `invalid ${MATCH_PREVIEW_MAX_BYTES_ENV}: expected a positive integer`,
    );
  }
  return parsed;
}

/**
 * 원본 줄은 신뢰할 수 없는 파일 내용이므로 길이 상한이 실제 경계에 필요하다.
 * UTF-8 continuation byte(10xxxxxx)에서 멈추지 않도록 문자 경계까지 되감는다.
 */
function clampMatchPreview(
  text: string,
  maxBytes: number,
): Pick<SearchMatch, 'text' | 'textBytes'> & { textTruncated?: true } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { text, textBytes: buffer.byteLength };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: `${buffer.subarray(0, end).toString('utf8')}${MATCH_PREVIEW_TRUNCATION_SUFFIX}`,
    textBytes: buffer.byteLength,
    textTruncated: true,
  };
}

export function parseRipgrepMatchLine(
  line: string,
  args: {
    rgPath: string;
    workspaceRoot: string;
    matchPreviewMaxBytes: number;
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
    ...clampMatchPreview(
      typeof linesInfo?.text === 'string'
        ? linesInfo.text.replace(/\n$/u, '')
        : '',
      args.matchPreviewMaxBytes,
    ),
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
        toolFailureDiagnostics: {
          phase: 'content_scan',
          reasonCode: 'ripgrep_exit_nonzero',
          retryHint:
            'Review the ripgrep diagnostic, then correct the pattern, include glob, or filesystem access before retrying.',
        },
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
