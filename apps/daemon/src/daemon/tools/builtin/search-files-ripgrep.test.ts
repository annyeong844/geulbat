import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCommandSessionHost } from '../../../command-host/session-core.js';
import {
  fromRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';
import { buildRipgrepCloseError } from './search-files-ripgrep-result.js';
import {
  parseRipgrepMatchLine,
  resolveSearchMatchPreviewMaxBytes,
} from './search-files-ripgrep-result.js';
import {
  isRipgrepBinaryCompatibleWithRoot,
  resolveRipgrepPath,
} from './search-files-ripgrep.js';

void test('resolveRipgrepPath finds an accessible ripgrep binary', async () => {
  const rgPath = await resolveRipgrepPath();

  assert.match(rgPath, /rg(?:\.exe)?$/iu);
  await access(rgPath);
});

void test('resolveRipgrepPath prefers a Windows-native binary for a WSL drive', async (t) => {
  const whereExecutable = '/mnt/c/Windows/System32/where.exe';
  try {
    await access(whereExecutable);
  } catch {
    t.skip('Windows interop is unavailable');
    return;
  }
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-rg-resolve-host-'));
  const pageLimitBytes = 4096;
  const hostCommands = createCommandSessionHost({
    inlineMaxBytes: pageLimitBytes,
    tailRingBytes: pageLimitBytes,
  });
  t.after(async () => {
    await hostCommands.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  let rgPath: string;
  try {
    rgPath = await resolveRipgrepPath('/mnt/c/Users/user', {
      hostCommands,
      stateRoot,
      pageLimitBytes,
    });
  } catch {
    t.skip('Windows ripgrep is unavailable');
    return;
  }

  assert.match(rgPath, /\.exe$/iu);
  await access(rgPath);
});

void test('isRipgrepBinaryCompatibleWithRoot rejects cross-host binary roots', () => {
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('/usr/bin/rg', 'C:\\workspace'),
    false,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('/usr/bin/rg', '/tmp/workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', 'C:\\workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', '/mnt/c/workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', '/tmp/workspace'),
    false,
  );
});

void test('fromRipgrepFsPath keeps native Windows paths for Windows workspaces', () => {
  assert.equal(
    fromRipgrepFsPath(
      'C:\\workspace\\docs\\note.md',
      'C:\\tools\\rg.exe',
      'C:\\workspace',
    ),
    'C:\\workspace\\docs\\note.md',
  );
});

void test('fromRipgrepFsPath converts Windows ripgrep paths for WSL workspaces', () => {
  assert.equal(
    fromRipgrepFsPath(
      'C:\\workspace\\docs\\note.md',
      'C:\\tools\\rg.exe',
      '/mnt/c/workspace',
    ),
    '/mnt/c/workspace/docs/note.md',
  );
});

void test('fromRipgrepFsPath converts Windows paths for the global Computer root', () => {
  assert.equal(
    fromRipgrepFsPath(
      'C:\\Users\\user\\docs\\note.md',
      'C:\\tools\\rg.exe',
      '/',
    ),
    '/mnt/c/Users/user/docs/note.md',
  );
});

void test('toWorkspaceRelativeSearchPath uses Windows semantics regardless of host OS', () => {
  assert.equal(
    toWorkspaceRelativeSearchPath(
      'C:\\workspace',
      'C:\\workspace\\docs\\note.md',
    ),
    'docs/note.md',
  );
});

void test('buildRipgrepCloseError treats canonical symlink cycles as completed traversal', () => {
  assert.equal(
    buildRipgrepCloseError({
      exitCode: 2,
      killed: false,
      stderr:
        'rg: File system loop found: /root/docs/loop points to an ancestor /root/docs\n',
    }),
    null,
  );
});

void test('buildRipgrepCloseError preserves non-cycle traversal failures', () => {
  const error = buildRipgrepCloseError({
    exitCode: 2,
    killed: false,
    stderr: 'rg: /root/private: Permission denied\n',
  });

  assert.ok(error);
  assert.equal((error as Error & { code?: string }).code, 'execution_failed');
  assert.match(error.message, /Permission denied/u);
  assert.deepEqual(
    (
      error as Error & {
        toolFailureDiagnostics?: unknown;
      }
    ).toolFailureDiagnostics,
    {
      phase: 'content_scan',
      reasonCode: 'ripgrep_exit_nonzero',
      retryHint:
        'Review the ripgrep diagnostic, then correct the pattern, include glob, or filesystem access before retrying.',
    },
  );
});

function ripgrepMatchEvent(text: string): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/workspace/generated/index.json' },
      line_number: 1,
      lines: { text: `${text}\n` },
    },
  });
}

void test('parseRipgrepMatchLine keeps a short match verbatim', () => {
  const match = parseRipgrepMatchLine(ripgrepMatchEvent('const needle = 1;'), {
    rgPath: '/usr/bin/rg',
    workspaceRoot: '/workspace',
    matchPreviewMaxBytes: 2000,
  });

  assert.deepEqual(match, {
    path: 'generated/index.json',
    line: 1,
    text: 'const needle = 1;',
    textBytes: 17,
  });
});

void test('parseRipgrepMatchLine clamps a single oversized match line', () => {
  // 생성된 index/minified 파일은 파일 전체가 한 줄이라 매치 하나가 수 MB가 된다.
  const oversized = 'x'.repeat(50_000);
  const match = parseRipgrepMatchLine(ripgrepMatchEvent(oversized), {
    rgPath: '/usr/bin/rg',
    workspaceRoot: '/workspace',
    matchPreviewMaxBytes: 2000,
  });

  assert.ok(match);
  assert.equal(match.textBytes, 50_000);
  assert.equal(match.textTruncated, true);
  assert.equal(match.text, `${'x'.repeat(2000)}... [truncated]`);
});

void test('parseRipgrepMatchLine never splits a multi-byte character', () => {
  // 한글은 UTF-8 3바이트다. 바이트 상한이 문자 경계와 맞지 않아도 깨진 문자를
  // 남기면 안 된다.
  const match = parseRipgrepMatchLine(ripgrepMatchEvent('가'.repeat(100)), {
    rgPath: '/usr/bin/rg',
    workspaceRoot: '/workspace',
    matchPreviewMaxBytes: 10,
  });

  assert.ok(match);
  assert.equal(match.textTruncated, true);
  assert.equal(match.textBytes, 300);
  assert.equal(match.text, `${'가'.repeat(3)}... [truncated]`);
  assert.ok(!match.text.includes('\uFFFD'));
});

void test('resolveSearchMatchPreviewMaxBytes defaults without configuration', () => {
  assert.equal(resolveSearchMatchPreviewMaxBytes({}), 2000);
});

void test('resolveSearchMatchPreviewMaxBytes honours an operator override', () => {
  assert.equal(
    resolveSearchMatchPreviewMaxBytes({
      GEULBAT_SEARCH_FILES_MATCH_PREVIEW_MAX_BYTES: '8192',
    }),
    8192,
  );
});

void test('resolveSearchMatchPreviewMaxBytes fails closed on an unusable override', () => {
  // 조용히 기본값으로 되돌리면 운영자가 잘못 설정한 사실을 알 수 없다.
  for (const raw of ['0', '-1', 'abc', '2000.5', '']) {
    assert.throws(
      () =>
        resolveSearchMatchPreviewMaxBytes({
          GEULBAT_SEARCH_FILES_MATCH_PREVIEW_MAX_BYTES: raw,
        }),
      /GEULBAT_SEARCH_FILES_MATCH_PREVIEW_MAX_BYTES/u,
    );
  }
});
