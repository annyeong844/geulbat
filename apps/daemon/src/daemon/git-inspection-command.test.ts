import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { HostCommandRuntime } from '../command-host/contract.js';
import { createCommandSessionHost } from '../command-host/session-core.js';
import {
  buildGitInspectionEnvironment,
  captureGitObjectIndexSnapshot,
  decodeGitAscii,
  decodeGitSingleLine,
  GIT_INSPECTION_GLOBAL_ARGUMENTS,
  gitModeClass,
  readNodeErrorCode,
  readGitBlobObject,
  splitGitNulRecords,
} from './git-inspection-command.js';
import {
  buildGitLogicalEntries,
  buildGitStagedLayerEntries,
  buildGitUnstagedLayerEntries,
} from './git-logical-diff.js';
import { captureGitReviewObservation } from './git-review-observation.js';
import {
  canonicalizeGitWorktreeContent,
  captureGitWorktreeComparisonEntries,
  captureGitWorktreeFile,
  hashGitBlobContent,
} from './git-worktree-capture.js';

const linuxTest = process.platform === 'linux' ? test : test.skip;
const execFileAsync = promisify(execFile);

void test('Git inspection environment drops ambient Git policy and unrelated process state', () => {
  const environment = buildGitInspectionEnvironment(
    {
      PATH: '/fixture/bin',
      TMPDIR: '/fixture/tmp',
      HOME: '/private/home',
      GEULBAT_TEST_SECRET: 'do-not-inherit',
      GIT_DIR: '/redirected/repository',
      GIT_INDEX_FILE: '/redirected/index',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'diff.external',
      GIT_CONFIG_VALUE_0: 'marker-helper',
      GIT_TRACE2_EVENT: '/tmp/git-trace.json',
    },
    'linux',
  );

  assert.deepEqual(environment, {
    PATH: '/fixture/bin',
    TMPDIR: '/fixture/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
  });
});

void test('Git inspection environment keeps only required Windows launch state', () => {
  const environment = buildGitInspectionEnvironment(
    {
      PATH: 'C:\\Git\\cmd',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\PublicProfile',
      GIT_TRACE: 'C:\\Temp\\trace.log',
    },
    'win32',
  );

  assert.equal(environment.PATH, 'C:\\Git\\cmd');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(environment.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(environment.TEMP, 'C:\\Temp');
  assert.equal(environment.USERPROFILE, undefined);
  assert.equal(environment.GIT_TRACE, undefined);
  assert.equal(environment.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(environment.GIT_CONFIG_SYSTEM, 'NUL');
});

void test('Git inspection global arguments pin read-only process behavior', () => {
  assert.deepEqual(GIT_INSPECTION_GLOBAL_ARGUMENTS, [
    '--no-optional-locks',
    '--literal-pathspecs',
    '-c',
    'color.ui=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'diff.autoRefreshIndex=false',
    '-c',
    'diff.external=',
    '-c',
    'diff.renames=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'credential.helper=',
  ]);
});

void test('Git inspection scalar decoders reject ambiguous boundary values', () => {
  assert.equal(splitGitNulRecords(Buffer.from([0])), undefined);
  assert.equal(decodeGitAscii(Buffer.from([0x80])), undefined);
  assert.equal(decodeGitSingleLine(Buffer.from([0xc2, 0x0a])), undefined);
  assert.equal(gitModeClass('040000'), 'unknown');
  assert.equal(readNodeErrorCode(new Error('without a code')), undefined);
});

void linuxTest(
  'Git worktree capture reads one regular file from its verified handle',
  async (t) => {
    const root = await createCaptureRoot(t);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'tracked.txt'), 'captured\n', 'utf8');

    const result = await captureGitWorktreeFile({
      repositoryRoot: root,
      relativePath: Buffer.from('nested/tracked.txt'),
      maxBytes: 1024,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.content.toString('utf8'), 'captured\n');
    assert.equal(result.evidence.size, 9n);
    assert.ok(result.evidence.inode > 0n);
  },
);

void linuxTest(
  'Git worktree capture preserves raw non-UTF-8 path bytes',
  async (t) => {
    const root = await createCaptureRoot(t);
    const relativePath = Buffer.from([
      0x72, 0x61, 0x77, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74,
    ]);
    await writeFile(
      Buffer.concat([Buffer.from(`${root}/`), relativePath]),
      Buffer.from([0x00, 0xff, 0x41]),
    );

    const result = await captureGitWorktreeFile({
      repositoryRoot: root,
      relativePath,
      maxBytes: 1024,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.content, Buffer.from([0x00, 0xff, 0x41]));
  },
);

void linuxTest(
  'Git worktree capture rejects absolute and escaping raw paths',
  async (t) => {
    const root = await createCaptureRoot(t);
    for (const relativePath of [
      Buffer.from('/absolute'),
      Buffer.from('../escape'),
      Buffer.from('nested/../escape'),
      Buffer.from('nested//file'),
      Buffer.from('nested/./file'),
      Buffer.from([0x66, 0x00, 0x69, 0x6c, 0x65]),
    ]) {
      assert.deepEqual(
        await captureGitWorktreeFile({
          repositoryRoot: root,
          relativePath,
          maxBytes: 1024,
        }),
        { ok: false, reason: 'invalid_path' },
      );
    }
  },
);

void linuxTest(
  'Git worktree capture never follows final or ancestor symlinks',
  async (t) => {
    const root = await createCaptureRoot(t);
    const outside = await createCaptureRoot(t);
    const linkContainer = await createCaptureRoot(t);
    await writeFile(join(outside, 'secret.txt'), 'outside\n', 'utf8');
    await writeFile(join(root, 'inside.txt'), 'inside\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'final-link'));
    await symlink(outside, join(root, 'ancestor-link'), 'dir');
    const linkedRoot = join(linkContainer, 'root-link');
    await symlink(root, linkedRoot, 'dir');

    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('final-link'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'unsupported_file_type' },
    );
    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('ancestor-link/secret.txt'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'unsupported_file_type' },
    );
    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: linkedRoot,
        relativePath: Buffer.from('inside.txt'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'unsupported_file_type' },
    );
  },
);

void linuxTest(
  'Git worktree capture rejects socket entries without opening them',
  async (t) => {
    const root = await createCaptureRoot(t);
    const socketPath = join(root, 'entry.sock');
    const server = createServer();
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('entry.sock'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'unsupported_file_type' },
    );
  },
);

void linuxTest(
  'Git worktree capture rejects a FIFO without opening it',
  async (t) => {
    const root = await createCaptureRoot(t);
    const fifoPath = join(root, 'entry.fifo');
    await execFileAsync('mkfifo', [fifoPath]);

    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('entry.fifo'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'unsupported_file_type' },
    );
  },
);

void linuxTest(
  'Git worktree capture reports configured resource exhaustion without reading',
  async (t) => {
    const root = await createCaptureRoot(t);
    await writeFile(join(root, 'large.txt'), 'five!', 'utf8');

    await assert.rejects(
      captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('large.txt'),
        maxBytes: -1,
      }),
      /maxBytes must be non-negative/u,
    );
    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('large.txt'),
        maxBytes: 4,
      }),
      { ok: false, reason: 'resource_limit' },
    );
  },
);

void linuxTest(
  'Git worktree capture reports a missing entry explicitly',
  async (t) => {
    const root = await createCaptureRoot(t);

    assert.deepEqual(
      await captureGitWorktreeFile({
        repositoryRoot: root,
        relativePath: Buffer.from('missing.txt'),
        maxBytes: 1024,
      }),
      { ok: false, reason: 'entry_missing' },
    );
  },
);

void linuxTest(
  'Git worktree capture refuses content that changes during the verified read',
  async (t) => {
    const root = await createCaptureRoot(t);
    const path = join(root, 'changing.bin');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x61));
    const writer = await open(path, 'r+');
    let active = true;
    let writes = 0;
    const mutation = (async () => {
      const byte = Buffer.alloc(1);
      while (active) {
        byte[0] = writes % 2 === 0 ? 0x62 : 0x63;
        await writer.write(byte, 0, 1, 0);
        writes += 1;
        await yieldEventLoop();
      }
    })();
    while (writes < 2) {
      await yieldEventLoop();
    }

    try {
      assert.deepEqual(
        await captureGitWorktreeFile({
          repositoryRoot: root,
          relativePath: Buffer.from('changing.bin'),
          maxBytes: 16 * 1024 * 1024,
        }),
        { ok: false, reason: 'observation_changed' },
      );
    } finally {
      active = false;
      await mutation;
      await writer.close();
    }
  },
);

void linuxTest(
  'Git object/index capture preserves raw paths, exact blobs, and the index bytes',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    const rawPath = Buffer.from([
      0x72, 0x61, 0x77, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74,
    ]);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'head\n');
    await writeFile(
      Buffer.concat([Buffer.from(`${fixture.repositoryRoot}/`), rawPath]),
      'raw-head\n',
    );
    await runGit(fixture.repositoryRoot, ['add', '-A']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'index\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);

    const marker = join(fixture.repositoryRoot, 'helper-marker');
    const helper = join(fixture.repositoryRoot, 'marker-helper.sh');
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`,
      'utf8',
    );
    await chmod(helper, 0o755);
    await runGit(fixture.repositoryRoot, ['config', 'core.fsmonitor', helper]);
    await runGit(fixture.repositoryRoot, ['config', 'diff.external', helper]);
    await runGit(fixture.repositoryRoot, [
      'config',
      'diff.marker.textconv',
      helper,
    ]);
    await runGit(fixture.repositoryRoot, [
      'config',
      'filter.marker.clean',
      helper,
    ]);
    await runGit(fixture.repositoryRoot, [
      'config',
      'filter.marker.process',
      helper,
    ]);
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      'tracked.txt filter=marker diff=marker\n',
      'utf8',
    );

    const indexBefore = await readFile(
      join(fixture.repositoryRoot, '.git', 'index'),
    );
    const captured = await captureSnapshot(fixture);
    const indexAfter = await readFile(
      join(fixture.repositoryRoot, '.git', 'index'),
    );

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(indexAfter, indexBefore);
    await assert.rejects(
      readFile(join(fixture.repositoryRoot, '.git', 'index.lock')),
      { code: 'ENOENT' },
    );
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.ok(captured.snapshot.headObjectId !== null);
    assert.deepEqual(captured.snapshot.branch, {
      name: 'main',
      detached: false,
    });
    assert.equal(captured.snapshot.headEntries.length, 2);
    assert.equal(captured.snapshot.indexEntries.length, 2);
    assert.equal(
      captured.snapshot.headEntries.some((entry) => entry.path.equals(rawPath)),
      true,
    );
    assert.equal(
      captured.snapshot.indexEntries.some((entry) =>
        entry.path.equals(rawPath),
      ),
      true,
    );

    const staged = buildGitStagedLayerEntries(captured.snapshot);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.state, 'modified');
    assert.equal(staged[0]?.afterPath?.toString('utf8'), 'tracked.txt');

    const headEntry = captured.snapshot.headEntries.find((entry) =>
      entry.path.equals(Buffer.from('tracked.txt')),
    );
    const indexEntry = captured.snapshot.indexEntries.find(
      (entry) =>
        entry.stage === 0 && entry.path.equals(Buffer.from('tracked.txt')),
    );
    assert.ok(headEntry);
    assert.ok(indexEntry);
    const headBlob = await readBlob(fixture, headEntry.objectId);
    const indexBlob = await readBlob(fixture, indexEntry.objectId);
    assert.deepEqual(headBlob, { ok: true, content: Buffer.from('head\n') });
    assert.deepEqual(indexBlob, { ok: true, content: Buffer.from('index\n') });
    assert.deepEqual(await readBlob(fixture, 'HEAD'), {
      ok: false,
      reason: 'invalid_object_id',
      message: 'Git blob reads require one full hexadecimal object id.',
    });
  },
);

void test('an unborn repository uses empty-tree staged semantics', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'new\n');
  await runGit(fixture.repositoryRoot, ['add', 'new.txt']);

  const captured = await captureSnapshot(fixture);

  assert.equal(captured.ok, true);
  if (!captured.ok) {
    return;
  }
  assert.equal(captured.snapshot.headObjectId, null);
  assert.deepEqual(captured.snapshot.branch, {
    name: 'main',
    detached: false,
  });
  assert.deepEqual(captured.snapshot.headEntries, []);
  const staged = buildGitStagedLayerEntries(captured.snapshot);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.state, 'added');
  assert.equal(staged[0]?.afterPath?.toString('utf8'), 'new.txt');
});

void test('object/index capture preserves detached branch identity', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'head\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await runGit(fixture.repositoryRoot, ['checkout', '--detach', '-q']);

  const captured = await captureSnapshot(fixture);

  assert.equal(captured.ok, true);
  if (!captured.ok) {
    return;
  }
  assert.deepEqual(captured.snapshot.branch, {
    name: null,
    detached: true,
  });
});

void linuxTest(
  'object and index capture classifies malformed Git command results',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'base\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);

    const scenarios = [
      invalidGitOutputScenario(
        'bare classification',
        matchesLastGitArgument('--is-bare-repository'),
        'neither\n',
        'Git returned an invalid bare-repository classification.',
      ),
      gitCommandFailureScenario(
        'worktree root command',
        matchesLastGitArgument('--show-toplevel'),
        'Git could not resolve the repository worktree root.',
        'not_repository',
      ),
      invalidGitOutputScenario(
        'worktree root output',
        matchesLastGitArgument('--show-toplevel'),
        '',
        'Git returned an invalid repository worktree root.',
      ),
      invalidGitOutputScenario(
        'object format',
        matchesLastGitArgument('--show-object-format'),
        'sha512\n',
        'Git returned an unsupported repository object format.',
      ),
      gitCommandFailureScenario(
        'HEAD command',
        matchesLastGitArgument('HEAD^{commit}'),
        'Git could not resolve HEAD.',
      ),
      invalidGitOutputScenario(
        'HEAD output',
        matchesLastGitArgument('HEAD^{commit}'),
        'not-an-object-id\n',
        'Git returned an invalid HEAD object id.',
      ),
      gitCommandFailureScenario(
        'branch command',
        includesGitArgument('symbolic-ref'),
        'Git could not resolve the current branch.',
      ),
      invalidGitOutputScenario(
        'branch output',
        includesGitArgument('symbolic-ref'),
        '\n',
        'Git returned an invalid current branch.',
      ),
      gitCommandFailureScenario(
        'HEAD tree command',
        includesGitArgument('ls-tree'),
        'Git could not read the captured HEAD tree.',
      ),
      invalidGitOutputScenario(
        'HEAD tree output',
        includesGitArgument('ls-tree'),
        'invalid-tree-record\\0',
        'Git returned an invalid HEAD tree inventory.',
      ),
      gitCommandFailureScenario(
        'index command',
        includesGitArgument('--stage'),
        'Git could not read the captured index.',
      ),
      invalidGitOutputScenario(
        'index output',
        includesGitArgument('--stage'),
        'invalid-index-record\\0',
        'Git returned an invalid index inventory.',
      ),
      invalidGitOutputScenario(
        'index path output',
        includesGitArgument('--git-path'),
        'relative-index\n',
        'Git returned an invalid index path.',
      ),
      invalidGitOutputScenario(
        'index path is a directory',
        includesGitArgument('--git-path'),
        `${fixture.repositoryRoot.replaceAll('%', '%%')}\n`,
        'Git index path is not a regular file.',
      ),
    ] as const;

    for (const scenario of scenarios) {
      const captured = await captureGitObjectIndexSnapshot({
        hostCommands: replaceGitInspectionCommand(fixture, scenario),
        stateRoot: fixture.stateRoot,
        workingDirectory: fixture.repositoryRoot,
        pageLimitBytes: 64,
        maxOutputBytesPerStream: 1024 * 1024,
      });

      assert.deepEqual(captured, scenario.expected, scenario.name);
    }
  },
);

void linuxTest(
  'worktree comparison resolves Git attributes for raw paths and hashes canonical regular and symlink content',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    const rawPath = Buffer.from([
      0x72, 0x61, 0x77, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74,
    ]);
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      '*.txt text ident\n*.bin -text\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, 'tracked.txt'),
      'before\n$Id$\n',
    );
    await writeFile(join(fixture.repositoryRoot, 'raw.bin'), 'before\r\n');
    await runGit(fixture.repositoryRoot, ['add', '-A']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);

    await writeFile(
      join(fixture.repositoryRoot, 'tracked.txt'),
      'after\r\n$Id: expanded $\r\n',
    );
    await writeFile(join(fixture.repositoryRoot, 'raw.bin'), 'after\r\n');
    await writeFile(
      Buffer.concat([Buffer.from(`${fixture.repositoryRoot}/`), rawPath]),
      'raw-path\r\n',
    );
    await symlink(
      'tracked.txt',
      join(fixture.repositoryRoot, 'untracked-link'),
    );

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    const captured = await captureGitWorktreeComparisonEntries({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      snapshot: objectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    const byPath = new Map(
      captured.entries.map((entry) => [entry.path.toString('base64'), entry]),
    );
    const tracked = byPath.get(Buffer.from('tracked.txt').toString('base64'));
    const raw = byPath.get(Buffer.from('raw.bin').toString('base64'));
    const rawNamed = byPath.get(rawPath.toString('base64'));
    const link = byPath.get(Buffer.from('untracked-link').toString('base64'));
    assert.ok(tracked);
    assert.ok(raw);
    assert.ok(rawNamed);
    assert.ok(link);
    assert.equal(
      tracked.objectId,
      await runGitOutput(fixture.repositoryRoot, [
        'hash-object',
        '--path=tracked.txt',
        '--',
        'tracked.txt',
      ]),
    );
    assert.equal(
      raw.objectId,
      await runGitOutput(fixture.repositoryRoot, [
        'hash-object',
        '--path=raw.bin',
        '--',
        'raw.bin',
      ]),
    );
    assert.equal(
      rawNamed.objectId,
      hashGitBlobContent(Buffer.from('raw-path\n'), 'sha1'),
    );
    assert.deepEqual(
      {
        mode: link.mode,
        objectId: link.objectId,
        contentKind: link.contentKind,
      },
      {
        mode: '120000',
        objectId: hashGitBlobContent(Buffer.from('tracked.txt'), 'sha1'),
        contentKind: 'symlink',
      },
    );

    const layers = buildGitUnstagedLayerEntries(
      objectIndex.snapshot,
      captured.entries,
    );
    assert.deepEqual(
      layers.map((entry) => ({
        comparison: entry.comparison,
        state: entry.state,
        path: (entry.afterPath ?? entry.beforePath)?.toString('base64'),
      })),
      [
        {
          comparison: 'untracked',
          state: 'untracked',
          path: rawPath.toString('base64'),
        },
        {
          comparison: 'unstaged',
          state: 'modified',
          path: Buffer.from('raw.bin').toString('base64'),
        },
        {
          comparison: 'unstaged',
          state: 'modified',
          path: Buffer.from('tracked.txt').toString('base64'),
        },
        {
          comparison: 'untracked',
          state: 'untracked',
          path: Buffer.from('untracked-link').toString('base64'),
        },
      ],
    );
  },
);

void linuxTest(
  'worktree comparison classifies malformed inventory, config, and attribute commands',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'base\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await writeFile(join(fixture.repositoryRoot, 'untracked.txt'), 'new\n');
    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }

    const scenarios = [
      gitCommandFailureScenario(
        'inventory command',
        includesGitArgument('--others'),
        'Git could not read the worktree inventory.',
      ),
      invalidGitOutputScenario(
        'inventory output',
        includesGitArgument('--others'),
        'missing-nul',
        'Git returned an invalid worktree inventory.',
      ),
      invalidGitOutputScenario(
        'duplicate inventory path',
        includesGitArgument('--others'),
        'tracked.txt\\0tracked.txt\\0',
        'Git returned an invalid or duplicate worktree path.',
      ),
      gitCommandFailureScenario(
        'config command',
        matchesLastGitArgument('core.autocrlf'),
        'Git could not read core.autocrlf.',
      ),
      invalidGitOutputScenario(
        'core.autocrlf output',
        matchesLastGitArgument('core.autocrlf'),
        'true\nfalse\n',
        'Git returned an invalid core.autocrlf value.',
      ),
      invalidGitOutputScenario(
        'core.filemode output',
        matchesLastGitArgument('core.filemode'),
        'invalid-test-value\n',
        'Git returned an invalid core.filemode value.',
      ),
      gitCommandFailureScenario(
        'attribute command',
        includesGitArgument('check-attr'),
        'Git could not resolve worktree canonicalization attributes.',
      ),
      invalidGitOutputScenario(
        'attribute output',
        includesGitArgument('check-attr'),
        'invalid-attribute-output',
        'Git returned invalid worktree canonicalization attributes.',
      ),
    ] as const;

    for (const scenario of scenarios) {
      const captured = await captureGitWorktreeComparisonEntries({
        hostCommands: replaceGitInspectionCommand(fixture, scenario),
        stateRoot: fixture.stateRoot,
        snapshot: objectIndex.snapshot,
        pageLimitBytes: 64,
        maxOutputBytesPerStream: 1024 * 1024,
        maxFileBytes: 1024 * 1024,
      });

      assert.deepEqual(captured, scenario.expected, scenario.name);
    }
  },
);

void linuxTest(
  'worktree comparison captures gitlinks, special entries, nested files, and auto text with index CRLF',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      'preserved.txt -text\nlegacy.txt crlf=input\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, 'preserved.txt'),
      'kept\r\nas-crlf\r\n',
    );
    await writeFile(join(fixture.repositoryRoot, 'legacy.txt'), 'before\n');
    await writeFile(
      join(fixture.repositoryRoot, 'diagnostic.pipe'),
      'regular placeholder\n',
    );
    await runGit(fixture.repositoryRoot, ['add', '-A']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);

    const headObjectId = await runGitOutput(fixture.repositoryRoot, [
      'rev-parse',
      'HEAD',
    ]);
    await runGit(fixture.repositoryRoot, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${headObjectId},vendor`,
    ]);
    await mkdir(join(fixture.repositoryRoot, 'vendor'));
    await rm(join(fixture.repositoryRoot, 'diagnostic.pipe'));
    await execFileAsync('mkfifo', [
      join(fixture.repositoryRoot, 'diagnostic.pipe'),
    ]);
    await mkdir(join(fixture.repositoryRoot, 'nested'));
    await writeFile(
      join(fixture.repositoryRoot, 'nested', 'untracked.txt'),
      'nested\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      'preserved.txt text=auto\nlegacy.txt crlf=input\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, 'preserved.txt'),
      'kept\r\nas-crlf\r\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, 'legacy.txt'),
      'after\r\nchanged\r\n',
    );
    await runGit(fixture.repositoryRoot, ['config', 'core.autocrlf', 'input']);
    await runGit(fixture.repositoryRoot, ['config', 'core.filemode', 'false']);
    await chmod(join(fixture.repositoryRoot, 'preserved.txt'), 0o755);

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    const captured = await captureGitWorktreeComparisonEntries({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      snapshot: objectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    const entries = new Map(
      captured.entries.map((entry) => [entry.path.toString('utf8'), entry]),
    );
    assert.deepEqual(entries.get('vendor'), {
      path: Buffer.from('vendor'),
      mode: '160000',
      objectId: null,
      contentKind: 'submodule',
      exactRenameIdentityVerified: false,
    });
    assert.deepEqual(entries.get('diagnostic.pipe'), {
      path: Buffer.from('diagnostic.pipe'),
      mode: 'special',
      objectId: null,
      contentKind: 'special',
      exactRenameIdentityVerified: false,
    });
    assert.equal(entries.get('nested/untracked.txt')?.contentKind, 'text');
    assert.equal(entries.get('preserved.txt')?.mode, '100644');
    assert.deepEqual(
      captured.contents.find((entry) =>
        entry.path.equals(Buffer.from('preserved.txt')),
      )?.canonicalContent,
      Buffer.from('kept\r\nas-crlf\r\n'),
    );
    assert.deepEqual(
      captured.contents.find((entry) =>
        entry.path.equals(Buffer.from('legacy.txt')),
      )?.canonicalContent,
      Buffer.from('after\nchanged\n'),
    );
  },
);

void linuxTest(
  'worktree comparison refuses named clean filters without invoking them',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    const marker = join(fixture.repositoryRoot, 'filter-invoked');
    const helper = join(fixture.repositoryRoot, 'filter-helper.sh');
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\ncat\n`,
    );
    await chmod(helper, 0o755);
    await runGit(fixture.repositoryRoot, [
      'config',
      'filter.marker.clean',
      helper,
    ]);
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      '* filter=marker\n',
    );
    await writeFile(join(fixture.repositoryRoot, 'filtered.txt'), 'content\n');

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    const captured = await captureGitWorktreeComparisonEntries({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      snapshot: objectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    assert.deepEqual(captured, {
      ok: false,
      reason: 'filtered_worktree_comparison_unsupported',
      message: 'Git attributes require an external clean filter.',
    });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  },
);

void linuxTest(
  'dirty tracked comparison refuses a newly configured clean filter without invoking it',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);

    const marker = join(fixture.repositoryRoot, 'filter-invoked');
    const helper = join(fixture.repositoryRoot, 'filter-helper.sh');
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\ncat\n`,
    );
    await chmod(helper, 0o755);
    await runGit(fixture.repositoryRoot, [
      'config',
      'filter.marker.clean',
      helper,
    ]);
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      'tracked.txt filter=marker\n',
    );
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'after\n');

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    assert.deepEqual(
      await captureGitWorktreeComparisonEntries({
        hostCommands: fixture.host,
        stateRoot: fixture.stateRoot,
        snapshot: objectIndex.snapshot,
        pageLimitBytes: 64,
        maxOutputBytesPerStream: 1024 * 1024,
        maxFileBytes: 1024 * 1024,
      }),
      {
        ok: false,
        reason: 'filtered_worktree_comparison_unsupported',
        message: 'Git attributes require an external clean filter.',
      },
    );
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  },
);

void linuxTest(
  'attribute and filter configuration replacement after preflight executes no helper',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'after\n');

    const marker = join(fixture.repositoryRoot, 'filter-invoked');
    const helper = join(fixture.repositoryRoot, 'filter-helper.sh');
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\ncat\n`,
    );
    await chmod(helper, 0o755);

    let policyOutputRef: string | undefined;
    let replaced = false;
    const replacingHost: HostCommandRuntime = {
      async start(args) {
        const started = await fixture.host.start(args);
        if (
          started.ok &&
          policyOutputRef === undefined &&
          args.executable === 'git' &&
          args.args.includes('check-attr')
        ) {
          policyOutputRef = started.outputRef;
        }
        return started;
      },
      async waitForInitialResult(args) {
        const result = await fixture.host.waitForInitialResult(args);
        if (!replaced && args.outputRef === policyOutputRef) {
          replaced = true;
          await runGit(fixture.repositoryRoot, [
            'config',
            'filter.marker.clean',
            helper,
          ]);
          await writeFile(
            join(fixture.repositoryRoot, '.gitattributes'),
            'tracked.txt filter=marker\n',
          );
        }
        return result;
      },
      interact: fixture.host.interact.bind(fixture.host),
      listThreadSessions: fixture.host.listThreadSessions.bind(fixture.host),
      closeAll: fixture.host.closeAll.bind(fixture.host),
    };

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    const captured = await captureGitWorktreeComparisonEntries({
      hostCommands: replacingHost,
      stateRoot: fixture.stateRoot,
      snapshot: objectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    assert.equal(replaced, true);
    assert.equal(captured.ok, false);
    if (!captured.ok) {
      assert.equal(captured.reason, 'observation_changed');
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  },
);

void linuxTest(
  'review summary does not read clean tracked file content',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(
      join(fixture.repositoryRoot, 'tracked.txt'),
      'clean tracked content\n',
    );
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);

    const captured = await captureGitReviewObservation({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      workingDirectory: fixture.repositoryRoot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 0,
    });

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(captured.observation.logicalEntries, []);
  },
);

void linuxTest(
  'review summary does not resolve a clean tracked file filter',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    const marker = join(fixture.stateRoot, 'filter-invoked');
    const helper = join(fixture.stateRoot, 'filter-helper.sh');
    await writeFile(
      join(fixture.repositoryRoot, '.gitattributes'),
      '* filter=marker\n',
    );
    await writeFile(
      join(fixture.repositoryRoot, 'tracked.txt'),
      'clean tracked content\n',
    );
    await runGit(fixture.repositoryRoot, ['add', '-A']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\ncat\n`,
    );
    await chmod(helper, 0o755);
    await runGit(fixture.repositoryRoot, [
      'config',
      'filter.marker.clean',
      helper,
    ]);

    const captured = await captureGitReviewObservation({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      workingDirectory: fixture.repositoryRoot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 0,
    });

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(captured.observation.logicalEntries, []);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  },
);

void linuxTest(
  'review summary still captures dirty tracked file content',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
    await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'after\n');

    const captured = await captureGitReviewObservation({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      workingDirectory: fixture.repositoryRoot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 0,
    });

    assert.deepEqual(captured, {
      ok: false,
      reason: 'resource_limit',
      message: 'A Git worktree entry exceeded the configured capture boundary.',
    });
  },
);

void linuxTest(
  'unstaged exact renames require one unambiguous canonical identity pair',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
    await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
    await rm(join(fixture.repositoryRoot, 'old.txt'));
    await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'same\n');

    const objectIndex = await captureSnapshot(fixture);
    assert.equal(objectIndex.ok, true);
    if (!objectIndex.ok) {
      return;
    }
    const worktree = await captureGitWorktreeComparisonEntries({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      snapshot: objectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    assert.equal(
      worktree.entries.find((entry) =>
        entry.path.equals(Buffer.from('new.txt')),
      )?.exactRenameIdentityVerified,
      true,
    );
    const renamed = buildGitUnstagedLayerEntries(
      objectIndex.snapshot,
      worktree.entries,
    );
    assert.deepEqual(
      renamed.map((entry) => ({
        comparison: entry.comparison,
        state: entry.state,
        before: entry.beforePath?.toString('utf8'),
        after: entry.afterPath?.toString('utf8'),
      })),
      [
        {
          comparison: 'unstaged',
          state: 'renamed',
          before: 'old.txt',
          after: 'new.txt',
        },
      ],
    );

    await rm(join(fixture.repositoryRoot, 'new.txt'));
    await runGit(fixture.repositoryRoot, ['reset', '--hard', 'HEAD']);
    await writeFile(join(fixture.repositoryRoot, 'old-copy.txt'), 'same\n');
    await runGit(fixture.repositoryRoot, ['add', 'old-copy.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'duplicate']);
    await rm(join(fixture.repositoryRoot, 'old.txt'));
    await rm(join(fixture.repositoryRoot, 'old-copy.txt'));
    await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'same\n');

    const ambiguousObjectIndex = await captureSnapshot(fixture);
    assert.equal(ambiguousObjectIndex.ok, true);
    if (!ambiguousObjectIndex.ok) {
      return;
    }
    const ambiguousWorktree = await captureGitWorktreeComparisonEntries({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      snapshot: ambiguousObjectIndex.snapshot,
      pageLimitBytes: 64,
      maxOutputBytesPerStream: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });
    assert.equal(ambiguousWorktree.ok, true);
    if (!ambiguousWorktree.ok) {
      return;
    }
    const ambiguous = buildGitUnstagedLayerEntries(
      ambiguousObjectIndex.snapshot,
      ambiguousWorktree.entries,
    );
    assert.equal(
      ambiguous.some((entry) => entry.state === 'renamed'),
      false,
    );
    assert.deepEqual(
      ambiguous.map((entry) => entry.state),
      ['untracked', 'deleted', 'deleted'],
    );
  },
);

void test('a matching worktree digest without byte equality proof is not a rename', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'old\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);

  const snapshot = await captureSnapshot(fixture);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) {
    return;
  }
  const oldEntry = snapshot.snapshot.indexEntries.find(
    (entry) => entry.stage === 0 && entry.path.equals(Buffer.from('old.txt')),
  );
  assert.ok(oldEntry);
  const layers = buildGitUnstagedLayerEntries(snapshot.snapshot, [
    {
      path: Buffer.from('new.txt'),
      mode: oldEntry.mode,
      objectId: oldEntry.objectId,
      contentKind: 'text',
      exactRenameIdentityVerified: false,
    },
  ]);

  assert.deepEqual(
    layers.map((entry) => ({
      state: entry.state,
      path: (entry.afterPath ?? entry.beforePath)?.toString('utf8'),
    })),
    [
      { state: 'untracked', path: 'new.txt' },
      { state: 'deleted', path: 'old.txt' },
    ],
  );

  const incompatibleModeLayers = buildGitUnstagedLayerEntries(
    snapshot.snapshot,
    [
      {
        path: Buffer.from('new-link'),
        mode: '120000',
        objectId: oldEntry.objectId,
        contentKind: 'symlink',
        exactRenameIdentityVerified: true,
      },
    ],
  );
  assert.deepEqual(
    incompatibleModeLayers.map((entry) => ({
      state: entry.state,
      contentKinds: [entry.beforeContentKind, entry.afterContentKind],
    })),
    [
      { state: 'untracked', contentKinds: [null, 'symlink'] },
      { state: 'deleted', contentKinds: ['unknown', null] },
    ],
  );
});

void test('exact staged renames require one unambiguous object identity pair', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await runGit(fixture.repositoryRoot, ['mv', 'old.txt', 'new.txt']);

  const renamed = await captureSnapshot(fixture);
  assert.equal(renamed.ok, true);
  if (!renamed.ok) {
    return;
  }
  const renamedLayers = buildGitStagedLayerEntries(renamed.snapshot);
  assert.equal(renamedLayers.length, 1);
  assert.equal(renamedLayers[0]?.state, 'renamed');
  assert.equal(renamedLayers[0]?.beforePath?.toString('utf8'), 'old.txt');
  assert.equal(renamedLayers[0]?.afterPath?.toString('utf8'), 'new.txt');

  await runGit(fixture.repositoryRoot, ['reset', '--hard', 'HEAD']);
  await writeFile(join(fixture.repositoryRoot, 'old-copy.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old-copy.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'duplicate']);
  await rm(join(fixture.repositoryRoot, 'old.txt'));
  await rm(join(fixture.repositoryRoot, 'old-copy.txt'));
  await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', '-A']);

  const ambiguous = await captureSnapshot(fixture);
  assert.equal(ambiguous.ok, true);
  if (!ambiguous.ok) {
    return;
  }
  const ambiguousLayers = buildGitStagedLayerEntries(ambiguous.snapshot);
  assert.equal(
    ambiguousLayers.some((entry) => entry.state === 'renamed'),
    false,
  );
  assert.deepEqual(ambiguousLayers.map((entry) => entry.state).sort(), [
    'added',
    'deleted',
    'deleted',
  ]);
});

void test('worktree canonicalization matches Git raw, text, auto, ident, and UTF-8 identity behavior', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  const attributes = [
    'raw.bin -text',
    'text.txt text',
    'auto.txt text=auto',
    'binary.bin text=auto',
    'ident.txt -text ident',
    'ident-open.txt -text ident',
    'ident-multiline.txt -text ident',
    'control.bin -text',
    'utf8.txt text working-tree-encoding=UTF8',
    'auto-preserved.txt -text',
    '',
  ].join('\n');
  await writeFile(join(fixture.repositoryRoot, '.gitattributes'), attributes);

  const rawPolicy = {
    text: 'raw',
    ident: false,
    workingTreeEncoding: null,
    indexHasCrLf: false,
  } as const;
  const identPolicy = { ...rawPolicy, ident: true } as const;
  const cases = [
    {
      path: 'raw.bin',
      content: Buffer.from([0, 0x0d, 0x0a, 0xff]),
      policy: rawPolicy,
      expected: Buffer.from([0, 0x0d, 0x0a, 0xff]),
      contentKind: 'binary',
    },
    {
      path: 'text.txt',
      content: Buffer.from('one\r\ntwo\r\n'),
      policy: {
        text: 'text' as const,
        ident: false,
        workingTreeEncoding: null,
        indexHasCrLf: false,
      },
      expected: Buffer.from('one\ntwo\n'),
      contentKind: 'text',
    },
    {
      path: 'auto.txt',
      content: Buffer.from('auto\r\ntext\r\n'),
      policy: {
        text: 'auto' as const,
        ident: false,
        workingTreeEncoding: null,
        indexHasCrLf: false,
      },
      expected: Buffer.from('auto\ntext\n'),
      contentKind: 'text',
    },
    {
      path: 'binary.bin',
      content: Buffer.from([0, 0x0d, 0x0a, 0x41]),
      policy: {
        text: 'auto' as const,
        ident: false,
        workingTreeEncoding: null,
        indexHasCrLf: false,
      },
      expected: Buffer.from([0, 0x0d, 0x0a, 0x41]),
      contentKind: 'binary',
    },
    {
      path: 'ident.txt',
      content: Buffer.from('before $Id: old value $ after\n'),
      policy: identPolicy,
      expected: Buffer.from('before $Id$ after\n'),
      contentKind: 'text',
    },
    {
      path: 'ident-open.txt',
      content: Buffer.from('before $Id: without a closing marker\n'),
      policy: identPolicy,
      expected: Buffer.from('before $Id: without a closing marker\n'),
      contentKind: 'text',
    },
    {
      path: 'ident-multiline.txt',
      content: Buffer.from('before $Id: first line\nsecond line $ after\n'),
      policy: identPolicy,
      expected: Buffer.from('before $Id: first line\nsecond line $ after\n'),
      contentKind: 'text',
    },
    {
      path: 'control.bin',
      content: Buffer.from([0x0d, 0x7f, 0x08, 0x01, 0x1a]),
      policy: rawPolicy,
      expected: Buffer.from([0x0d, 0x7f, 0x08, 0x01, 0x1a]),
      contentKind: 'binary',
    },
    {
      path: 'utf8.txt',
      content: Buffer.from('한글\r\n'),
      policy: {
        text: 'text' as const,
        ident: false,
        workingTreeEncoding: 'uTf8',
        indexHasCrLf: false,
      },
      expected: Buffer.from('한글\n'),
      contentKind: 'text',
    },
  ] as const;

  for (const fixtureCase of cases) {
    await writeFile(
      join(fixture.repositoryRoot, fixtureCase.path),
      fixtureCase.content,
    );
    const canonical = canonicalizeGitWorktreeContent(
      fixtureCase.content,
      fixtureCase.policy,
    );
    assert.equal(canonical.ok, true);
    if (!canonical.ok) {
      continue;
    }
    assert.deepEqual(canonical.canonicalContent, fixtureCase.expected);
    assert.equal(canonical.contentKind, fixtureCase.contentKind);
    await assertCanonicalContentMatchesGit(
      fixture.repositoryRoot,
      fixtureCase.path,
      canonical.canonicalContent,
    );
  }

  const preservedContent = Buffer.from('kept\r\nas-crlf\r\n');
  await writeFile(
    join(fixture.repositoryRoot, 'auto-preserved.txt'),
    preservedContent,
  );
  await runGit(fixture.repositoryRoot, [
    'add',
    '.gitattributes',
    'auto-preserved.txt',
  ]);
  await writeFile(
    join(fixture.repositoryRoot, '.gitattributes'),
    attributes.replace(
      'auto-preserved.txt -text',
      'auto-preserved.txt text=auto',
    ),
  );
  const preserved = canonicalizeGitWorktreeContent(preservedContent, {
    text: 'auto',
    ident: false,
    workingTreeEncoding: null,
    indexHasCrLf: true,
  });
  assert.deepEqual(preserved, {
    ok: true,
    canonicalContent: preservedContent,
    contentKind: 'text',
  });
  assert.equal(
    await runGitOutput(fixture.repositoryRoot, [
      'diff',
      '--name-only',
      '--',
      'auto-preserved.txt',
    ]),
    '',
  );

  assert.deepEqual(
    canonicalizeGitWorktreeContent(Buffer.from('unsupported\n'), {
      text: 'text',
      ident: false,
      workingTreeEncoding: 'UTF-16LE',
      indexHasCrLf: false,
    }),
    { ok: false, reason: 'unsupported_worktree_transformation' },
  );
});

void test('unsupported encoding on an optional rename candidate remains deterministic delete and add', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(
    join(fixture.repositoryRoot, '.gitattributes'),
    'new.utf16 text working-tree-encoding=UTF-16LE\n',
  );
  await runGit(fixture.repositoryRoot, ['add', '.gitattributes']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'attributes']);
  await rm(join(fixture.repositoryRoot, 'old.txt'));
  await writeFile(
    join(fixture.repositoryRoot, 'new.utf16'),
    Buffer.from([0x73, 0x00, 0x61, 0x00, 0x6d, 0x00, 0x65, 0x00, 0x0a, 0x00]),
  );

  const captured = await captureObservation(fixture);

  assert.equal(captured.ok, true);
  if (!captured.ok) {
    return;
  }
  assert.deepEqual(
    captured.observation.unstagedLayers.map((layer) => ({
      state: layer.state,
      path: (layer.afterPath ?? layer.beforePath)?.toString('utf8'),
    })),
    [
      { state: 'untracked', path: 'new.utf16' },
      { state: 'deleted', path: 'old.txt' },
    ],
  );
});

void test('object snapshots and worktree blob hashing preserve SHA-1 and SHA-256 repository identity', async (t) => {
  for (const objectFormat of ['sha1', 'sha256'] as const) {
    const fixture = await createGitInspectionFixture(t, { objectFormat });
    const content = Buffer.from(`${objectFormat}\r\ncontent\n`);
    await writeFile(join(fixture.repositoryRoot, 'identity.txt'), content);
    await runGit(fixture.repositoryRoot, ['add', 'identity.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', objectFormat]);

    const captured = await captureSnapshot(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      continue;
    }
    assert.equal(captured.snapshot.objectFormat, objectFormat);
    assert.equal(
      hashGitBlobContent(content, objectFormat),
      await runGitOutput(fixture.repositoryRoot, [
        'hash-object',
        '--no-filters',
        '--',
        'identity.txt',
      ]),
    );
  }
});

void test('a missing promisor blob does not lazy-fetch or invoke credentials', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'promised\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  const objectId = await runGitOutput(fixture.repositoryRoot, [
    'rev-parse',
    'HEAD:tracked.txt',
  ]);
  const marker = join(fixture.repositoryRoot, 'credential-invoked');
  const helper = join(fixture.repositoryRoot, 'credential-helper.sh');
  await writeFile(
    helper,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 1\n`,
  );
  await chmod(helper, 0o755);
  await runGit(fixture.repositoryRoot, [
    'config',
    'remote.origin.url',
    'https://example.invalid/repository.git',
  ]);
  await runGit(fixture.repositoryRoot, [
    'config',
    'remote.origin.promisor',
    'true',
  ]);
  await runGit(fixture.repositoryRoot, [
    'config',
    'remote.origin.partialclonefilter',
    'blob:none',
  ]);
  await runGit(fixture.repositoryRoot, [
    'config',
    'extensions.partialClone',
    'origin',
  ]);
  await runGit(fixture.repositoryRoot, ['config', 'credential.helper', helper]);
  await rm(
    join(
      fixture.repositoryRoot,
      '.git',
      'objects',
      objectId.slice(0, 2),
      objectId.slice(2),
    ),
  );

  const result = await readBlob(fixture, objectId);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'object_unavailable');
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

void test('unstaged layers preserve index-to-worktree truth and separate untracked files', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  for (const path of [
    'clean.txt',
    'deleted.txt',
    'mode.txt',
    'modified.txt',
    'type-change.txt',
  ]) {
    await writeFile(join(fixture.repositoryRoot, path), `${path}\n`);
  }
  await runGit(fixture.repositoryRoot, ['add', '-A']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'index']);
  const captured = await captureSnapshot(fixture);
  assert.equal(captured.ok, true);
  if (!captured.ok) {
    return;
  }

  const indexByPath = new Map(
    captured.snapshot.indexEntries
      .filter((entry) => entry.stage === 0)
      .map((entry) => [entry.path.toString('utf8'), entry]),
  );
  const clean = indexByPath.get('clean.txt');
  const mode = indexByPath.get('mode.txt');
  assert.ok(clean);
  assert.ok(mode);
  const modifiedContent = Buffer.from('modified worktree\n');
  const untrackedContent = Buffer.from('untracked\n');
  const typeChangedTarget = Buffer.from('target.txt');
  const layers = buildGitUnstagedLayerEntries(captured.snapshot, [
    {
      path: Buffer.from('clean.txt'),
      mode: clean.mode,
      objectId: clean.objectId,
      contentKind: 'text',
      exactRenameIdentityVerified: false,
    },
    {
      path: Buffer.from('mode.txt'),
      mode: '100755',
      objectId: mode.objectId,
      contentKind: 'text',
      exactRenameIdentityVerified: false,
    },
    {
      path: Buffer.from('modified.txt'),
      mode: '100644',
      objectId: hashGitBlobContent(
        modifiedContent,
        captured.snapshot.objectFormat,
      ),
      contentKind: 'text',
      exactRenameIdentityVerified: false,
    },
    {
      path: Buffer.from('type-change.txt'),
      mode: '120000',
      objectId: hashGitBlobContent(
        typeChangedTarget,
        captured.snapshot.objectFormat,
      ),
      contentKind: 'symlink',
      exactRenameIdentityVerified: false,
    },
    {
      path: Buffer.from('untracked.txt'),
      mode: '100644',
      objectId: hashGitBlobContent(
        untrackedContent,
        captured.snapshot.objectFormat,
      ),
      contentKind: 'text',
      exactRenameIdentityVerified: false,
    },
  ]);

  assert.deepEqual(
    layers.map((entry) => ({
      comparison: entry.comparison,
      state: entry.state,
      path: (entry.afterPath ?? entry.beforePath)?.toString('utf8'),
    })),
    [
      {
        comparison: 'unstaged',
        state: 'deleted',
        path: 'deleted.txt',
      },
      {
        comparison: 'unstaged',
        state: 'modified',
        path: 'mode.txt',
      },
      {
        comparison: 'unstaged',
        state: 'modified',
        path: 'modified.txt',
      },
      {
        comparison: 'unstaged',
        state: 'type_changed',
        path: 'type-change.txt',
      },
      {
        comparison: 'untracked',
        state: 'untracked',
        path: 'untracked.txt',
      },
    ],
  );
  assert.deepEqual(
    layers
      .filter(
        (entry) =>
          (entry.afterPath ?? entry.beforePath)?.toString('utf8') ===
          'type-change.txt',
      )
      .map((entry) => ({
        state: entry.state,
        beforeContentKind: entry.beforeContentKind,
        afterContentKind: entry.afterContentKind,
      })),
    [
      {
        state: 'type_changed',
        beforeContentKind: 'unknown',
        afterContentKind: 'symlink',
      },
    ],
  );
});

void linuxTest(
  'unstaged layers preserve symlink-to-regular content kinds',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await symlink('target.txt', join(fixture.repositoryRoot, 'entry'));
    await runGit(fixture.repositoryRoot, ['add', 'entry']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'symlink']);
    await rm(join(fixture.repositoryRoot, 'entry'));
    await writeFile(join(fixture.repositoryRoot, 'entry'), 'target.txt');

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(
      captured.observation.logicalEntries[0]?.layers.map((layer) => {
        assert.ok(
          layer.comparison === 'unstaged' || layer.comparison === 'untracked',
        );
        return {
          state: layer.state,
          beforeContentKind: layer.beforeContentKind,
          afterContentKind: layer.afterContentKind,
        };
      }),
      [
        {
          state: 'type_changed',
          beforeContentKind: 'symlink',
          afterContentKind: 'text',
        },
      ],
    );
  },
);

void linuxTest(
  'logical entries connect staged and unstaged exact rename continuity',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'a.txt'), 'same\n');
    await runGit(fixture.repositoryRoot, ['add', 'a.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await rename(
      join(fixture.repositoryRoot, 'a.txt'),
      join(fixture.repositoryRoot, 'b.txt'),
    );
    await runGit(fixture.repositoryRoot, ['add', '-A']);
    await rename(
      join(fixture.repositoryRoot, 'b.txt'),
      join(fixture.repositoryRoot, 'c.txt'),
    );

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.equal(captured.observation.logicalEntries.length, 1);
    const logical = captured.observation.logicalEntries[0];
    assert.ok(logical);
    assert.equal(logical.displayPath.toString('utf8'), 'c.txt');
    assert.deepEqual(
      logical.paths.map((path) => path.toString('utf8')),
      ['a.txt', 'b.txt', 'c.txt'],
    );
    assert.deepEqual(
      logical.layers.map((layer) => [layer.comparison, layer.state]),
      [
        ['staged', 'renamed'],
        ['unstaged', 'renamed'],
      ],
    );
    assert.deepEqual(
      logical.exactRenameProofs.map((proof) => [
        proof.comparison,
        proof.verification,
      ]),
      [
        ['staged', 'object_identity'],
        ['unstaged', 'canonical_byte_equality'],
      ],
    );
    assert.match(logical.structuralIdentity, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(
      buildGitLogicalEntries(
        captured.observation.stagedLayers,
        captured.observation.unstagedLayers,
      )[0]?.structuralIdentity,
      logical.structuralIdentity,
    );
  },
);

void linuxTest(
  'logical entries coalesce staged deletion and same-path untracked recreation',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'recreated.txt'), 'old\n');
    await runGit(fixture.repositoryRoot, ['add', 'recreated.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await runGit(fixture.repositoryRoot, ['rm', '-q', 'recreated.txt']);
    await writeFile(join(fixture.repositoryRoot, 'recreated.txt'), 'new\n');

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.equal(captured.observation.logicalEntries.length, 1);
    const logical = captured.observation.logicalEntries[0];
    assert.ok(logical);
    assert.equal(logical.displayPath.toString('utf8'), 'recreated.txt');
    assert.deepEqual(
      logical.layers.map((layer) => [layer.comparison, layer.state]),
      [
        ['staged', 'deleted'],
        ['untracked', 'untracked'],
      ],
    );
  },
);

void linuxTest(
  'logical entries retain staged and unstaged same-path modifications',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'head\n');
    await runGit(fixture.repositoryRoot, ['add', 'layered.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'index\n');
    await runGit(fixture.repositoryRoot, ['add', 'layered.txt']);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'worktree\n');

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.equal(captured.observation.logicalEntries.length, 1);
    assert.deepEqual(
      captured.observation.logicalEntries[0]?.layers.map((layer) => [
        layer.comparison,
        layer.state,
      ]),
      [
        ['staged', 'modified'],
        ['unstaged', 'modified'],
      ],
    );
  },
);

void linuxTest(
  'logical entries retain staged and unstaged truth when worktree returns to HEAD',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'head\n');
    await runGit(fixture.repositoryRoot, ['add', 'layered.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'index\n');
    await runGit(fixture.repositoryRoot, ['add', 'layered.txt']);
    await writeFile(join(fixture.repositoryRoot, 'layered.txt'), 'head\n');

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(
      captured.observation.logicalEntries[0]?.layers.map((layer) => [
        layer.comparison,
        layer.state,
      ]),
      [
        ['staged', 'modified'],
        ['unstaged', 'modified'],
      ],
    );
  },
);

void linuxTest(
  'logical entries retain a staged add followed by a worktree delete',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'new\n');
    await runGit(fixture.repositoryRoot, ['add', 'new.txt']);
    await rm(join(fixture.repositoryRoot, 'new.txt'));

    const captured = await captureObservation(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    assert.deepEqual(
      captured.observation.logicalEntries[0]?.layers.map((layer) => [
        layer.comparison,
        layer.state,
      ]),
      [
        ['staged', 'added'],
        ['unstaged', 'deleted'],
      ],
    );
  },
);

void linuxTest(
  'staged conflicts preserve Git index stages 1, 2, and 3',
  async (t) => {
    const fixture = await createGitInspectionFixture(t);
    const path = join(fixture.repositoryRoot, 'conflict.txt');
    await writeFile(path, 'base\n');
    await runGit(fixture.repositoryRoot, ['add', 'conflict.txt']);
    await runGit(fixture.repositoryRoot, ['commit', '-qm', 'base']);
    await runGit(fixture.repositoryRoot, ['checkout', '-qb', 'other']);
    await writeFile(path, 'other\n');
    await runGit(fixture.repositoryRoot, ['commit', '-qam', 'other']);
    await runGit(fixture.repositoryRoot, ['checkout', '-q', 'main']);
    await writeFile(path, 'main\n');
    await runGit(fixture.repositoryRoot, ['commit', '-qam', 'main']);
    await assert.rejects(
      runGit(fixture.repositoryRoot, ['merge', '--no-edit', 'other']),
    );

    const captured = await captureSnapshot(fixture);

    assert.equal(captured.ok, true);
    if (!captured.ok) {
      return;
    }
    const staged = buildGitStagedLayerEntries(captured.snapshot);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.comparison, 'conflict');
    assert.equal(staged[0]?.state, 'conflicted');
    assert.equal(staged[0]?.afterPath?.toString('utf8'), 'conflict.txt');
    assert.deepEqual(
      staged[0]?.conflictStages.map((entry) => entry.stage),
      [1, 2, 3],
    );
    const logical = buildGitLogicalEntries(staged, []);
    assert.equal(logical.length, 1);
    assert.deepEqual(
      logical[0]?.layers.map((layer) => [layer.comparison, layer.state]),
      [['conflict', 'conflicted']],
    );
  },
);

void test('object/index capture rejects a repository that changes during observation', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'head\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'head']);

  let indexReads = 0;
  const mutatingHost: HostCommandRuntime = {
    async start(args) {
      if (
        args.executable === 'git' &&
        args.args.includes('ls-files') &&
        (indexReads += 1) === 2
      ) {
        await writeFile(
          join(fixture.repositoryRoot, 'tracked.txt'),
          'changed\n',
        );
        await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
      }
      return await fixture.host.start(args);
    },
    waitForInitialResult: fixture.host.waitForInitialResult.bind(fixture.host),
    interact: fixture.host.interact.bind(fixture.host),
    listThreadSessions: fixture.host.listThreadSessions.bind(fixture.host),
    closeAll: fixture.host.closeAll.bind(fixture.host),
  };

  const captured = await captureGitObjectIndexSnapshot({
    hostCommands: mutatingHost,
    stateRoot: fixture.stateRoot,
    workingDirectory: fixture.repositoryRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024 * 1024,
  });

  assert.deepEqual(captured, {
    ok: false,
    reason: 'observation_changed',
    message:
      'Git HEAD or index changed while the object/index snapshot was captured.',
  });
});

void test('composite review capture rejects object/index changes across worktree assembly', async (t) => {
  const fixture = await createGitInspectionFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'head\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'head']);

  let bareRepositoryReads = 0;
  const mutatingHost: HostCommandRuntime = {
    async start(args) {
      if (
        args.executable === 'git' &&
        args.args.includes('--is-bare-repository') &&
        (bareRepositoryReads += 1) === 2
      ) {
        await writeFile(
          join(fixture.repositoryRoot, 'tracked.txt'),
          'changed\n',
        );
        await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
      }
      return await fixture.host.start(args);
    },
    waitForInitialResult: fixture.host.waitForInitialResult.bind(fixture.host),
    interact: fixture.host.interact.bind(fixture.host),
    listThreadSessions: fixture.host.listThreadSessions.bind(fixture.host),
    closeAll: fixture.host.closeAll.bind(fixture.host),
  };

  const captured = await captureGitReviewObservation({
    hostCommands: mutatingHost,
    stateRoot: fixture.stateRoot,
    workingDirectory: fixture.repositoryRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
  });

  assert.deepEqual(captured, {
    ok: false,
    reason: 'observation_changed',
    message:
      'Git repository identity, HEAD, or index changed while the review observation was captured.',
  });
});

void test('non-repository, bare repository, and output exhaustion are closed results', async (t) => {
  const nonRepository = await createCaptureRoot(t);
  const stateRoot = await createCaptureRoot(t);
  const host = createCommandSessionHost({
    inlineMaxBytes: 64,
    tailRingBytes: 1024,
  });
  t.after(async () => {
    await host.closeAll();
  });
  const missing = await captureGitObjectIndexSnapshot({
    hostCommands: host,
    stateRoot,
    workingDirectory: nonRepository,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, 'not_repository');
  }

  const bareRoot = await createCaptureRoot(t);
  await runGit(bareRoot, ['init', '--bare', '-q']);
  const bare = await captureGitObjectIndexSnapshot({
    hostCommands: host,
    stateRoot,
    workingDirectory: bareRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024,
  });
  assert.equal(bare.ok, false);
  if (!bare.ok) {
    assert.equal(bare.reason, 'bare_repository');
  }

  const limitedFixture = await createGitInspectionFixture(t);
  const limited = await captureGitObjectIndexSnapshot({
    hostCommands: limitedFixture.host,
    stateRoot: limitedFixture.stateRoot,
    workingDirectory: limitedFixture.repositoryRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 4,
  });
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.reason, 'resource_limit');
  }
});

interface GitInspectionFixture {
  host: ReturnType<typeof createCommandSessionHost>;
  repositoryRoot: string;
  stateRoot: string;
}

async function createGitInspectionFixture(
  t: TestContext,
  options: { objectFormat?: 'sha1' | 'sha256' } = {},
): Promise<GitInspectionFixture> {
  const repositoryRoot = await createCaptureRoot(t);
  const stateRoot = await createCaptureRoot(t);
  const host = createCommandSessionHost({
    inlineMaxBytes: 64,
    tailRingBytes: 1024,
  });
  t.after(async () => {
    await host.closeAll();
  });
  await runGit(repositoryRoot, [
    'init',
    '-q',
    '-b',
    'main',
    `--object-format=${options.objectFormat ?? 'sha1'}`,
  ]);
  await runGit(repositoryRoot, ['config', 'user.name', 'Geulbat Test']);
  await runGit(repositoryRoot, [
    'config',
    'user.email',
    'geulbat@example.invalid',
  ]);
  return { host, repositoryRoot, stateRoot };
}

interface GitInspectionCommandScenario {
  name: string;
  matches: (args: readonly string[]) => boolean;
  executable: string;
  replacementArgs: readonly string[];
  expected: {
    ok: false;
    reason: 'command_failed' | 'invalid_output' | 'not_repository';
    message: string;
  };
}

function gitCommandFailureScenario(
  name: string,
  matches: GitInspectionCommandScenario['matches'],
  message: string,
  reason: 'command_failed' | 'not_repository' = 'command_failed',
): GitInspectionCommandScenario {
  return {
    name,
    matches,
    executable: '/bin/sh',
    replacementArgs: ['-c', 'exit 2'],
    expected: { ok: false, reason, message },
  };
}

function invalidGitOutputScenario(
  name: string,
  matches: GitInspectionCommandScenario['matches'],
  output: string,
  message: string,
): GitInspectionCommandScenario {
  return {
    name,
    matches,
    executable: '/usr/bin/printf',
    replacementArgs: [output],
    expected: { ok: false, reason: 'invalid_output', message },
  };
}

function matchesLastGitArgument(expected: string) {
  return (args: readonly string[]) => args.at(-1) === expected;
}

function includesGitArgument(expected: string) {
  return (args: readonly string[]) => args.includes(expected);
}

function replaceGitInspectionCommand(
  fixture: GitInspectionFixture,
  replacement: Pick<
    GitInspectionCommandScenario,
    'matches' | 'executable' | 'replacementArgs'
  >,
): HostCommandRuntime {
  return {
    async start(args) {
      return await fixture.host.start(
        args.executable === 'git' && replacement.matches(args.args)
          ? {
              ...args,
              executable: replacement.executable,
              args: [...replacement.replacementArgs],
            }
          : args,
      );
    },
    waitForInitialResult: fixture.host.waitForInitialResult.bind(fixture.host),
    interact: fixture.host.interact.bind(fixture.host),
    listThreadSessions: fixture.host.listThreadSessions.bind(fixture.host),
    closeAll: fixture.host.closeAll.bind(fixture.host),
  };
}

async function captureSnapshot(fixture: GitInspectionFixture) {
  return await captureGitObjectIndexSnapshot({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    workingDirectory: fixture.repositoryRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024 * 1024,
  });
}

async function captureObservation(fixture: GitInspectionFixture) {
  return await captureGitReviewObservation({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    workingDirectory: fixture.repositoryRoot,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
  });
}

async function readBlob(fixture: GitInspectionFixture, objectId: string) {
  return await readGitBlobObject({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    repositoryRoot: fixture.repositoryRoot,
    objectId,
    pageLimitBytes: 64,
    maxOutputBytesPerStream: 1024 * 1024,
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    env: gitTestEnvironment(),
  });
}

async function runGitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: gitTestEnvironment(),
  });
  return stdout.trim();
}

async function assertCanonicalContentMatchesGit(
  repositoryRoot: string,
  relativePath: string,
  canonicalContent: Buffer,
): Promise<void> {
  const scratchPath = '.geulbat-canonical-content';
  await writeFile(join(repositoryRoot, scratchPath), canonicalContent);
  const [actualObjectId, canonicalObjectId] = await Promise.all([
    runGitOutput(repositoryRoot, [
      'hash-object',
      `--path=${relativePath}`,
      '--',
      relativePath,
    ]),
    runGitOutput(repositoryRoot, [
      'hash-object',
      '--no-filters',
      '--',
      scratchPath,
    ]),
  ]);
  assert.equal(
    actualObjectId,
    canonicalObjectId,
    `Git canonical object mismatch for ${relativePath}`,
  );
}

function gitTestEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function createCaptureRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-git-capture-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
