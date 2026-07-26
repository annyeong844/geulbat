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
