import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fromWindowsFsPath } from './search-files-ripgrep-paths.js';

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
        | 'powershell_unavailable'
        | 'query_failed';
    }
  | { kind: 'results'; paths: string[] };

export async function tryWindowsFilenameIndexSearch(args: {
  rootDir: string;
  pattern: string;
  signal?: AbortSignal;
}): Promise<WindowsFilenameIndexSearchResult> {
  const scope = toWindowsSearchScope(args.rootDir);
  if (scope === undefined) {
    return { kind: 'unavailable', reasonCode: 'unsupported_root' };
  }
  const exactFilename = readExactFilenamePattern(args.pattern);
  if (exactFilename === undefined) {
    return { kind: 'unavailable', reasonCode: 'pattern_not_exact' };
  }
  try {
    await access(WINDOWS_POWERSHELL_PATH);
  } catch {
    return { kind: 'unavailable', reasonCode: 'powershell_unavailable' };
  }

  const query = [
    'SELECT System.ItemUrl FROM SystemIndex',
    `WHERE SCOPE='${escapeWindowsSearchSqlLiteral(scope)}'`,
    `AND System.FileName='${escapeWindowsSearchSqlLiteral(exactFilename)}'`,
  ].join(' ');
  return await runWindowsSearchQuery({
    query,
    rootDir: args.rootDir,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
}

export function readExactFilenamePattern(pattern: string): string | undefined {
  const filename = pattern.split('/').at(-1);
  if (
    filename === undefined ||
    filename.length === 0 ||
    /[*?[\]{}\\]/u.test(filename)
  ) {
    return undefined;
  }
  return filename;
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
  signal?: AbortSignal;
}): Promise<WindowsFilenameIndexSearchResult> {
  return await new Promise((resolve, reject) => {
    const queryBase64 = Buffer.from(args.query, 'utf8').toString('base64');
    const encodedCommand = Buffer.from(
      WINDOWS_SEARCH_QUERY_SCRIPT.replace(
        '__GEULBAT_QUERY_BASE64__',
        queryBase64,
      ),
      'utf16le',
    ).toString('base64');
    const child = spawn(
      WINDOWS_POWERSHELL_PATH,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let killed = false;
    const killChild = () => {
      if (!killed) {
        killed = true;
        child.kill('SIGTERM');
      }
    };
    if (args.signal) {
      if (args.signal.aborted) {
        killChild();
      } else {
        args.signal.addEventListener('abort', killChild, { once: true });
      }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on('close', (exitCode) => {
      args.signal?.removeEventListener('abort', killChild);
      if (killed) {
        reject(
          Object.assign(new Error('Windows filename index aborted'), {
            code: 'aborted',
          }),
        );
        return;
      }
      if (exitCode !== 0) {
        resolve({ kind: 'unavailable', reasonCode: 'query_failed' });
        return;
      }
      try {
        resolve({
          kind: 'results',
          paths: stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) =>
              fromWindowsFsPath(
                Buffer.from(line, 'base64')
                  .toString('utf8')
                  .replaceAll('/', '\\'),
                args.rootDir,
              ),
            ),
        });
      } catch {
        resolve({ kind: 'unavailable', reasonCode: 'query_failed' });
      }
    });
    child.on('error', () => {
      args.signal?.removeEventListener('abort', killChild);
      resolve({ kind: 'unavailable', reasonCode: 'query_failed' });
    });
  });
}
