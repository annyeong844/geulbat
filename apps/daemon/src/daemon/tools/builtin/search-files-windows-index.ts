import { access } from 'node:fs/promises';
import { fromWindowsFsPath } from './search-files-ripgrep-paths.js';
import {
  createDelimitedFrameReader,
  streamHostRoutedCommandLines,
  type SearchFilesHostRouting,
} from './search-files-host-stream.js';

const WINDOWS_POWERSHELL_PATH =
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

const WINDOWS_SEARCH_QUERY_SCRIPT = [
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
  '$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("__GEULBAT_QUERY_BASE64__"))',
  '$connection=New-Object -ComObject ADODB.Connection',
  '$recordset=$null',
  'try {',
  '$connection.Open("Provider=Search.CollatorDSO;Extended Properties=\'Application=Windows\';")',
  '$recordset=$connection.Execute($query)',
  'while(-not $recordset.EOF) {',
  '$url=$recordset.Fields.Item("System.ItemUrl").Value',
  'if($null -ne $url -and $url.StartsWith("file:")) {',
  '$path=[Uri]::UnescapeDataString($url.Substring(5))',
  '[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)))',
  '}',
  '$recordset.MoveNext()',
  '}',
  '} finally {',
  'if($null -ne $recordset) { $recordset.Close() }',
  '$connection.Close()',
  '}',
].join('\n');

type WindowsFilenameIndexSearchResult =
  | {
      kind: 'unavailable';
      reasonCode:
        | 'unsupported_root'
        | 'pattern_not_exact'
        | 'pattern_not_indexable'
        | 'max_results_required'
        | 'powershell_unavailable'
        | 'command_runtime_unavailable'
        | 'query_failed';
    }
  | { kind: 'results'; paths: string[]; limited: boolean };

type WindowsFilenameIndexQueryMode = 'exact_hint' | 'bounded_basename_glob';

export async function tryWindowsFilenameIndexSearch(args: {
  rootDir: string;
  pattern: string;
  queryMode?: WindowsFilenameIndexQueryMode;
  maxResults?: number;
  signal?: AbortSignal;
  hostRouting?: SearchFilesHostRouting;
}): Promise<WindowsFilenameIndexSearchResult> {
  const scope = toWindowsSearchScope(args.rootDir);
  if (scope === undefined) {
    return { kind: 'unavailable', reasonCode: 'unsupported_root' };
  }
  const queryMode = args.queryMode ?? 'exact_hint';
  if (queryMode === 'bounded_basename_glob' && args.maxResults === undefined) {
    return { kind: 'unavailable', reasonCode: 'max_results_required' };
  }
  const query = buildWindowsFilenameIndexQuery({
    scope,
    pattern: args.pattern,
    queryMode,
    ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
  });
  if (query === undefined) {
    return {
      kind: 'unavailable',
      reasonCode:
        queryMode === 'exact_hint'
          ? 'pattern_not_exact'
          : 'pattern_not_indexable',
    };
  }
  if (args.hostRouting === undefined) {
    return {
      kind: 'unavailable',
      reasonCode: 'command_runtime_unavailable',
    };
  }
  try {
    await access(WINDOWS_POWERSHELL_PATH);
  } catch {
    return { kind: 'unavailable', reasonCode: 'powershell_unavailable' };
  }

  return await runWindowsSearchQuery({
    query,
    rootDir: args.rootDir,
    hostRouting: args.hostRouting,
    ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
}

export function readWindowsFilenameIndexPattern(
  pattern: string,
  queryMode: WindowsFilenameIndexQueryMode = 'exact_hint',
): { operator: '=' | 'LIKE'; literal: string } | undefined {
  if (
    queryMode === 'bounded_basename_glob' &&
    (pattern.includes('/') ||
      pattern.startsWith('!') ||
      /[[\]{}\\]/u.test(pattern))
  ) {
    return undefined;
  }
  const filename = pattern.split('/').at(-1);
  if (
    filename === undefined ||
    filename.length === 0 ||
    /[[\]{}\\]/u.test(filename)
  ) {
    return undefined;
  }
  if (!/[*?]/u.test(filename)) {
    return { operator: '=', literal: filename };
  }
  if (queryMode === 'exact_hint') {
    return undefined;
  }
  let literal = '';
  for (const character of filename) {
    if (character === '*') {
      literal += '%';
    } else if (character === '?') {
      literal += '_';
    } else if (character === '%') {
      literal += '[%]';
    } else if (character === '_') {
      literal += '[_]';
    } else {
      literal += character;
    }
  }
  return { operator: 'LIKE', literal };
}

export function buildWindowsFilenameIndexQuery(args: {
  scope: string;
  pattern: string;
  queryMode: WindowsFilenameIndexQueryMode;
  maxResults?: number;
}): string | undefined {
  const parsedPattern = readWindowsFilenameIndexPattern(
    args.pattern,
    args.queryMode,
  );
  if (
    parsedPattern === undefined ||
    (args.maxResults !== undefined &&
      (!Number.isInteger(args.maxResults) || args.maxResults <= 0))
  ) {
    return undefined;
  }
  const selectLimit =
    args.maxResults === undefined ? '' : ` TOP ${args.maxResults}`;
  const filenamePredicate =
    parsedPattern.operator === '='
      ? `System.FileName='${escapeWindowsSearchSqlLiteral(parsedPattern.literal)}'`
      : `System.FileName LIKE '${escapeWindowsSearchSqlLiteral(parsedPattern.literal)}'`;
  return [
    `SELECT${selectLimit} System.ItemUrl FROM SystemIndex`,
    `WHERE SCOPE='${escapeWindowsSearchSqlLiteral(args.scope)}'`,
    `AND ${filenamePredicate}`,
    'ORDER BY System.ItemUrl',
  ].join(' ');
}

function toWindowsSearchScope(rootDir: string): string | undefined {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(rootDir);
  if (!match) {
    return undefined;
  }
  const drive = match[1]?.toUpperCase();
  const tail = match[2];
  return tail ? `file:${drive}:/${tail}` : `file:${drive}:/`;
}

function escapeWindowsSearchSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function runWindowsSearchQuery(args: {
  query: string;
  rootDir: string;
  hostRouting: SearchFilesHostRouting;
  maxResults?: number;
  signal?: AbortSignal;
}): Promise<WindowsFilenameIndexSearchResult> {
  const queryBase64 = Buffer.from(args.query, 'utf8').toString('base64');
  const encodedCommand = Buffer.from(
    WINDOWS_SEARCH_QUERY_SCRIPT.replace(
      '__GEULBAT_QUERY_BASE64__',
      queryBase64,
    ),
    'utf16le',
  ).toString('base64');
  const paths: string[] = [];
  let invalidOutput = false;
  const frames = createDelimitedFrameReader('\n', (line) => {
    const encodedPath = line.trim();
    if (encodedPath.length === 0 || invalidOutput) {
      return;
    }
    try {
      paths.push(
        fromWindowsFsPath(
          Buffer.from(encodedPath, 'base64')
            .toString('utf8')
            .replaceAll('/', '\\'),
          args.rootDir,
        ),
      );
    } catch {
      invalidOutput = true;
    }
  });
  const streamed = await streamHostRoutedCommandLines({
    hostCommands: args.hostRouting.hostCommands,
    stateRoot: args.hostRouting.stateRoot,
    executable: WINDOWS_POWERSHELL_PATH,
    commandArgs: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand,
    ],
    cwd: args.hostRouting.stateRoot,
    env: process.env,
    pageLimitBytes: args.hostRouting.pageLimitBytes,
    onStdoutChunk: frames.consume,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  frames.flush();
  if (!streamed.ok) {
    if (streamed.aborted) {
      throw Object.assign(new Error('Windows filename index aborted'), {
        code: 'aborted',
      });
    }
    return { kind: 'unavailable', reasonCode: 'query_failed' };
  }
  if (
    streamed.value.status !== 'exit' ||
    streamed.value.exitCode !== 0 ||
    invalidOutput
  ) {
    return { kind: 'unavailable', reasonCode: 'query_failed' };
  }
  return {
    kind: 'results',
    paths,
    limited: args.maxResults !== undefined && paths.length >= args.maxResults,
  };
}
