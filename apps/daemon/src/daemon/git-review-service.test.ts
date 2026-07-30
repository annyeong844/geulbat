import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  isGitReviewFileResult,
  isGitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import { createCommandSessionHost } from '../command-host/session-core.js';
import {
  buildGitReviewDiffRows,
  createGitReviewObservationService,
  escapeGitReviewDisplayPath,
} from './git-review-service.js';

const execFileAsync = promisify(execFile);

void test('summary pages one immutable observation and release expires it', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'a.txt'), 'before a\n');
  await writeFile(join(fixture.repositoryRoot, 'b.txt'), 'before b\n');
  await runGit(fixture.repositoryRoot, ['add', '-A']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(join(fixture.repositoryRoot, 'a.txt'), 'after a\n');
  await writeFile(join(fixture.repositoryRoot, 'b.txt'), 'after b\n');
  await writeFile(join(fixture.repositoryRoot, 'c.txt'), 'new c\n');

  const service = createReviewService(fixture, { pageLimitBytes: 360 });
  const started = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });

  assert.equal(isGitReviewSummaryResult(started), true);
  assert.equal(started.kind, 'changed');
  if (started.kind !== 'changed') {
    return;
  }
  assert.deepEqual(started.totals, {
    fileCount: 3,
    additions: 3,
    deletions: 2,
    lineStatsComplete: true,
  });
  assert.equal(started.files.items.length, 1);
  assert.ok(started.files.nextCursor);
  const cursor = started.files.nextCursor;
  const loadedPaths = started.files.items.map((file) => file.displayPath);

  await writeFile(join(fixture.repositoryRoot, 'd.txt'), 'later\n');
  const continued = await service.summary({
    kind: 'continue',
    observationId: started.observationId,
    cursor,
  });

  assert.equal(isGitReviewSummaryResult(continued), true);
  assert.equal(continued.kind, 'changed');
  if (continued.kind !== 'changed') {
    return;
  }
  assert.equal(continued.observationId, started.observationId);
  assert.equal(continued.totals.fileCount, 3);
  loadedPaths.push(...continued.files.items.map((file) => file.displayPath));
  assert.equal(loadedPaths.includes('d.txt'), false);

  assert.deepEqual(
    service.release({
      kind: 'summary',
      observationId: started.observationId,
    }),
    { kind: 'released' },
  );
  assert.deepEqual(
    await service.summary({
      kind: 'continue',
      observationId: started.observationId,
      cursor,
    }),
    { kind: 'stale', reason: 'observation_expired' },
  );
  assert.deepEqual(
    service.release({
      kind: 'summary',
      observationId: started.observationId,
    }),
    { kind: 'released' },
  );
});

void test('summary cursors reject tampering and cross-observation reuse', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'a.txt'), 'a\n');
  await writeFile(join(fixture.repositoryRoot, 'b.txt'), 'b\n');

  const service = createReviewService(fixture, { pageLimitBytes: 360 });
  const first = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  const second = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(first.kind, 'changed');
  assert.equal(second.kind, 'changed');
  if (first.kind !== 'changed' || second.kind !== 'changed') {
    return;
  }
  assert.ok(first.files.nextCursor);

  assert.deepEqual(
    await service.summary({
      kind: 'continue',
      observationId: first.observationId,
      cursor: `${first.files.nextCursor}x`,
    }),
    { kind: 'stale', reason: 'cursor_invalid' },
  );
  assert.deepEqual(
    await service.summary({
      kind: 'continue',
      observationId: second.observationId,
      cursor: first.files.nextCursor,
    }),
    { kind: 'stale', reason: 'cursor_mismatch' },
  );
});

void test('summary projects branch, logical rename layers, and strict DTOs', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await rename(
    join(fixture.repositoryRoot, 'old.txt'),
    join(fixture.repositoryRoot, 'renamed.txt'),
  );
  await runGit(fixture.repositoryRoot, ['add', '-A']);

  const service = createReviewService(fixture);
  const result = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });

  assert.equal(isGitReviewSummaryResult(result), true);
  assert.equal(result.kind, 'changed');
  if (result.kind !== 'changed') {
    return;
  }
  assert.deepEqual(result.branch, {
    name: 'main',
    detached: false,
    headOid: result.branch.headOid,
  });
  assert.match(result.branch.headOid ?? '', /^[0-9a-f]{40}$/u);
  assert.equal(result.files.items.length, 1);
  assert.deepEqual(result.totals, {
    fileCount: 1,
    additions: 0,
    deletions: 0,
    lineStatsComplete: true,
  });
  const [file] = result.files.items;
  assert.ok(file);
  assert.equal(file.displayPath, 'renamed.txt');
  assert.equal(file.layers.length, 1);
  assert.deepEqual(
    file.layers.map((layer) => ({
      comparison: layer.comparison,
      state: layer.state,
      beforeDisplayPath: layer.beforeDisplayPath,
      afterDisplayPath: layer.afterDisplayPath,
    })),
    [
      {
        comparison: 'staged',
        state: 'renamed',
        beforeDisplayPath: 'old.txt',
        afterDisplayPath: 'renamed.txt',
      },
    ],
  );
});

void test('summary keeps staged deletion and same-path untracked content kinds in one entry', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'recreated.txt'), 'old\n');
  await runGit(fixture.repositoryRoot, ['add', 'recreated.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await runGit(fixture.repositoryRoot, ['rm', '-q', 'recreated.txt']);
  await writeFile(join(fixture.repositoryRoot, 'recreated.txt'), 'new\n');

  const result = await createReviewService(fixture).summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });

  assert.equal(result.kind, 'changed');
  if (result.kind !== 'changed') {
    return;
  }
  assert.equal(result.files.items.length, 1);
  assert.deepEqual(
    result.files.items[0]?.layers.map((layer) => ({
      comparison: layer.comparison,
      state: layer.state,
      beforeContentKind: layer.beforeContentKind,
      afterContentKind: layer.afterContentKind,
    })),
    [
      {
        comparison: 'staged',
        state: 'deleted',
        beforeContentKind: 'unknown',
        afterContentKind: null,
      },
      {
        comparison: 'untracked',
        state: 'untracked',
        beforeContentKind: null,
        afterContentKind: 'text',
      },
    ],
  );
});

void test('summary returns clean and closed directory/repository states', async (t) => {
  const fixture = await createGitReviewFixture(t);
  const service = createReviewService(fixture);

  const clean = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(clean.kind, 'clean');
  assert.equal(isGitReviewSummaryResult(clean), true);

  const missing = await service.summary({
    kind: 'start',
    workingDirectory: join(fixture.repositoryRoot, 'missing'),
  });
  assert.deepEqual(missing, {
    kind: 'not_reviewable',
    reason: 'missing_directory',
  });

  const ordinaryDirectory = await mkdtemp(join(tmpdir(), 'geulbat-not-git-'));
  t.after(async () => {
    await rm(ordinaryDirectory, { recursive: true, force: true });
  });
  const notRepository = await service.summary({
    kind: 'start',
    workingDirectory: ordinaryDirectory,
  });
  assert.deepEqual(notRepository, {
    kind: 'not_reviewable',
    reason: 'not_repository',
  });
});

void test('summary resolves portable Computer coordinates only against the configured base', async (t) => {
  const fixture = await createGitReviewFixture(t);
  const portableWorkingDirectory = basename(fixture.repositoryRoot);

  const withoutCoordinateBase = await createReviewService(fixture).summary({
    kind: 'start',
    workingDirectory: portableWorkingDirectory,
  });
  assert.deepEqual(withoutCoordinateBase, {
    kind: 'not_reviewable',
    reason: 'missing_directory',
  });

  const withCoordinateBase = await createReviewService(fixture, {
    coordinateBase: dirname(fixture.repositoryRoot),
  }).summary({
    kind: 'start',
    workingDirectory: portableWorkingDirectory,
  });
  assert.equal(withCoordinateBase.kind, 'clean');

  const computerRoot = await createReviewService(fixture, {
    coordinateBase: fixture.repositoryRoot,
  }).summary({
    kind: 'start',
    workingDirectory: '',
  });
  assert.equal(computerRoot.kind, 'clean');
});

void test('summary projects worktree capture exhaustion as unavailable', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'after\n');

  assert.deepEqual(
    await createReviewService(fixture, { maxFileBytes: 0 }).summary({
      kind: 'start',
      workingDirectory: fixture.repositoryRoot,
    }),
    { kind: 'unavailable', reason: 'resource_limit' },
  );
});

void test('summary closes Git blob output exhaustion as unavailable', async (t) => {
  const fixture = await createGitReviewFixture(t);
  const maxOutputBytesPerStream = 1024;
  const filePath = join(fixture.repositoryRoot, 'large.txt');
  await writeFile(filePath, Buffer.alloc(maxOutputBytesPerStream + 1, 0x61));
  await runGit(fixture.repositoryRoot, ['add', 'large.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(filePath, Buffer.alloc(maxOutputBytesPerStream + 1, 0x62));

  assert.deepEqual(
    await createReviewService(fixture, { maxOutputBytesPerStream }).summary({
      kind: 'start',
      workingDirectory: fixture.repositoryRoot,
    }),
    { kind: 'unavailable', reason: 'resource_limit' },
  );
});

void test('summary closes unsupported non-UTF-8 worktree encoding', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(
    join(fixture.repositoryRoot, '.gitattributes'),
    'tracked.txt text working-tree-encoding=UTF-16LE\n',
  );
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'after\n');

  assert.deepEqual(
    await createReviewService(fixture).summary({
      kind: 'start',
      workingDirectory: fixture.repositoryRoot,
    }),
    {
      kind: 'not_reviewable',
      reason: 'unsupported_worktree_transformation',
    },
  );
});

void test('optional unsupported rename candidate stays delete-add and projects metadata only', async (t) => {
  const fixture = await createGitReviewFixture(t);
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

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });

  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  assert.deepEqual(summary.totals, {
    fileCount: 2,
    additions: null,
    deletions: null,
    lineStatsComplete: false,
  });
  assert.deepEqual(
    summary.files.items.map((file) => ({
      displayPath: file.displayPath,
      states: file.layers.map((layer) => layer.state),
    })),
    [
      { displayPath: 'new.utf16', states: ['untracked'] },
      { displayPath: 'old.txt', states: ['deleted'] },
    ],
  );
  const file = summary.files.items.find(
    (candidate) => candidate.displayPath === 'new.utf16',
  );
  assert.ok(file);
  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });

  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.deepEqual(
    result.sections.map((section) => ({
      projection: section.projection,
      metadataReason: section.metadataReason,
    })),
    [
      {
        projection: 'metadata_only',
        metadataReason: 'unsupported_content_transformation',
      },
    ],
  );
  assert.equal(
    result.rows.items.some((row) => row.kind !== 'metadata'),
    false,
  );
});

void test('file capture projects its immutable summary snapshot until an explicit refresh', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n',
  );
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\nsummary\nfour\nfive\nsix\nseven\neight\n',
  );

  const service = createReviewService(fixture, { pageLimitBytes: 360 });
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);

  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\nlive\nfour\nfive\nsix\nseven\nlive-tail\n',
  );
  const started = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(isGitReviewFileResult(started), true);
  assert.equal(started.kind, 'ready');
  if (started.kind !== 'ready') {
    return;
  }
  assert.equal(started.sections.length, 1);
  assert.equal(started.sections[0]?.projection, 'text');
  assert.ok(started.rows.nextCursor);
  const rows = [...started.rows.items];

  let cursor: string | null = started.rows.nextCursor;
  while (cursor !== null) {
    const continued = await service.file({
      kind: 'continue',
      observationId: summary.observationId,
      fileId: file.fileId,
      fileObservationId: started.fileObservationId,
      cursor,
    });
    assert.equal(isGitReviewFileResult(continued), true);
    assert.equal(continued.kind, 'ready');
    if (continued.kind !== 'ready') {
      return;
    }
    rows.push(...continued.rows.items);
    cursor = continued.rows.nextCursor;
  }
  assert.equal(
    rows.some((row) => row.kind === 'addition' && row.content === 'summary'),
    true,
  );
  assert.equal(
    rows.some((row) => row.content.includes('live')),
    false,
  );

  const refreshedSummary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(refreshedSummary.kind, 'changed');
  if (refreshedSummary.kind !== 'changed') {
    return;
  }
  const refreshedFile = refreshedSummary.files.items[0];
  assert.ok(refreshedFile);
  const refreshed = await service.file({
    kind: 'start',
    observationId: refreshedSummary.observationId,
    fileId: refreshedFile.fileId,
  });
  assert.equal(refreshed.kind, 'ready');
  if (refreshed.kind !== 'ready') {
    return;
  }
  const refreshedRows = [...refreshed.rows.items];

  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\npost-capture\nfour\n',
  );
  cursor = refreshed.rows.nextCursor;
  while (cursor !== null) {
    const continued = await service.file({
      kind: 'continue',
      observationId: refreshedSummary.observationId,
      fileId: refreshedFile.fileId,
      fileObservationId: refreshed.fileObservationId,
      cursor,
    });
    assert.equal(continued.kind, 'ready');
    if (continued.kind !== 'ready') {
      return;
    }
    refreshedRows.push(...continued.rows.items);
    cursor = continued.rows.nextCursor;
  }
  assert.equal(
    refreshedRows.some(
      (row) => row.kind === 'addition' && row.content === 'live',
    ),
    true,
  );
  assert.equal(
    refreshedRows.some(
      (row) => row.kind === 'addition' && row.content === 'live-tail',
    ),
    true,
  );
  assert.equal(
    refreshedRows.some((row) => row.content.includes('post-capture')),
    false,
  );

  assert.deepEqual(
    await service.file({
      kind: 'continue',
      observationId: summary.observationId,
      fileId: file.fileId,
      fileObservationId: started.fileObservationId,
      cursor: `${started.rows.nextCursor}x`,
    }),
    { kind: 'stale', reason: 'cursor_invalid' },
  );
  for (const request of [
    {
      kind: 'continue' as const,
      observationId: 'other-observation',
      fileId: file.fileId,
      fileObservationId: started.fileObservationId,
      cursor: started.rows.nextCursor,
    },
    {
      kind: 'continue' as const,
      observationId: summary.observationId,
      fileId: 'other-file',
      fileObservationId: started.fileObservationId,
      cursor: started.rows.nextCursor,
    },
    {
      kind: 'continue' as const,
      observationId: summary.observationId,
      fileId: file.fileId,
      fileObservationId: 'other-file-observation',
      cursor: started.rows.nextCursor,
    },
  ]) {
    assert.deepEqual(await service.file(request), {
      kind: 'stale',
      reason: 'cursor_mismatch',
    });
  }

  assert.deepEqual(
    service.release({
      kind: 'file',
      observationId: summary.observationId,
      fileObservationId: started.fileObservationId,
    }),
    { kind: 'released' },
  );
  assert.deepEqual(
    service.release({
      kind: 'file',
      observationId: summary.observationId,
      fileObservationId: started.fileObservationId,
    }),
    { kind: 'released' },
  );
  assert.deepEqual(
    await service.file({
      kind: 'continue',
      observationId: summary.observationId,
      fileId: file.fileId,
      fileObservationId: started.fileObservationId,
      cursor: started.rows.nextCursor ?? 'missing',
    }),
    { kind: 'stale', reason: 'observation_expired' },
  );
  const recaptured = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(recaptured.kind, 'ready');
});

void test('file continuation remains in its captured observation after index and HEAD mutation', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n',
  );
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    'one\ntwo\ncaptured\nfour\nfive\nsix\nseven\ncaptured-tail\n',
  );

  const service = createReviewService(fixture, { pageLimitBytes: 360 });
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);
  const started = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(started.kind, 'ready');
  if (started.kind !== 'ready') {
    return;
  }
  assert.ok(started.rows.nextCursor);

  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'committed\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'post-capture']);
  const continued = await service.file({
    kind: 'continue',
    observationId: summary.observationId,
    fileId: file.fileId,
    fileObservationId: started.fileObservationId,
    cursor: started.rows.nextCursor,
  });

  assert.equal(continued.kind, 'ready');
  if (continued.kind !== 'ready') {
    return;
  }
  assert.equal(
    continued.rows.items.some((row) => row.content === 'committed'),
    false,
  );
});

void test('file capture preserves staged and unstaged section order and layer joins', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'head\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'index\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'worktree\n');

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);
  assert.deepEqual(
    file.layers.map((layer) => layer.comparison),
    ['staged', 'unstaged'],
  );
  assert.deepEqual(summary.totals, {
    fileCount: 1,
    additions: null,
    deletions: null,
    lineStatsComplete: false,
  });

  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(isGitReviewFileResult(result), true);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.deepEqual(
    result.sections.map((section) => ({
      comparison: section.comparison,
      layerId: section.layerId,
    })),
    file.layers.map((layer) => ({
      comparison: layer.comparison,
      layerId: layer.layerId,
    })),
  );
});

void test('file capture projects binary content as metadata only', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(
    join(fixture.repositoryRoot, 'binary.dat'),
    Buffer.from([0, 1, 2, 3]),
  );

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);
  assert.deepEqual(summary.totals, {
    fileCount: 1,
    additions: null,
    deletions: null,
    lineStatsComplete: false,
  });
  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });

  assert.equal(isGitReviewFileResult(result), true);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.deepEqual(result.sections, [
    {
      sectionId: result.sections[0]?.sectionId,
      layerId: file.layers[0]?.layerId,
      comparison: 'untracked',
      projection: 'metadata_only',
      metadataReason: 'binary',
    },
  ]);
  assert.equal(result.rows.items[0]?.kind, 'metadata');
});

void test('merge conflicts remain reviewable as one staged file', async (t) => {
  const fixture = await createGitReviewFixture(t);
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

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  assert.equal(summary.files.items.length, 1);
  const file = summary.files.items[0];
  assert.ok(file);
  assert.equal(file.displayPath, 'conflict.txt');
  assert.deepEqual(
    file.layers.map((layer) => [layer.comparison, layer.state]),
    [['conflict', 'conflicted']],
  );

  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.equal(result.sections[0]?.projection, 'conflict');
  assert.equal(
    result.rows.items[0]?.content,
    'Unmerged Git index stages: 1, 2, 3.',
  );
});

void test('exact unstaged rename remains immutable until refresh captures its drift', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await rm(join(fixture.repositoryRoot, 'old.txt'));
  await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'same\n');

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);
  assert.equal(file.layers[0]?.state, 'renamed');

  await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'different\n');
  const original = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(original.kind, 'ready');

  const refreshed = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(refreshed.kind, 'changed');
  if (refreshed.kind !== 'changed') {
    return;
  }
  assert.equal(
    refreshed.files.items.some((candidate) =>
      candidate.layers.some((layer) => layer.state === 'renamed'),
    ),
    false,
  );
});

void test('exact rename remains immutable until refresh captures new ambiguity', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'old.txt'), 'same\n');
  await runGit(fixture.repositoryRoot, ['add', 'old.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await rm(join(fixture.repositoryRoot, 'old.txt'));
  await writeFile(join(fixture.repositoryRoot, 'new.txt'), 'same\n');

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);
  assert.equal(file.layers[0]?.state, 'renamed');

  await writeFile(join(fixture.repositoryRoot, 'duplicate.txt'), 'same\n');
  const original = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(original.kind, 'ready');

  const refreshed = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(refreshed.kind, 'changed');
  if (refreshed.kind !== 'changed') {
    return;
  }
  assert.equal(
    refreshed.files.items.some((candidate) =>
      candidate.layers.some((layer) => layer.state === 'renamed'),
    ),
    false,
  );
});

void test('file capture refuses one row beyond the transport boundary without truncation', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'before\n');
  await runGit(fixture.repositoryRoot, ['add', 'tracked.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'initial']);
  await writeFile(
    join(fixture.repositoryRoot, 'tracked.txt'),
    `${'after'.repeat(160)}\n`,
  );

  const service = createReviewService(fixture, { pageLimitBytes: 360 });
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items[0];
  assert.ok(file);

  assert.deepEqual(
    await service.file({
      kind: 'start',
      observationId: summary.observationId,
      fileId: file.fileId,
    }),
    {
      kind: 'unavailable',
      reason: 'row_exceeds_transport_boundary',
    },
  );
});

void test('decoder-unsafe text attributes remain metadata-only', async (t) => {
  const fixture = await createGitReviewFixture(t);
  await writeFile(
    join(fixture.repositoryRoot, '.gitattributes'),
    'unsafe.txt text\n',
  );
  await writeFile(
    join(fixture.repositoryRoot, 'unsafe.txt'),
    Buffer.from([0xff, 0x41, 0x0a]),
  );

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  const file = summary.files.items.find(
    (candidate) => candidate.displayPath === 'unsafe.txt',
  );
  assert.ok(file);
  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });

  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.deepEqual(
    result.sections.map((section) => ({
      projection: section.projection,
      metadataReason: section.metadataReason,
    })),
    [{ projection: 'metadata_only', metadataReason: 'binary' }],
  );
  assert.equal(
    result.rows.items.some((row) => row.kind !== 'metadata'),
    false,
  );
});

void test('display paths preserve Unicode and escape ambiguous bytes', () => {
  assert.equal(
    escapeGitReviewDisplayPath(Buffer.from('폴더/파일.txt')),
    '폴더/파일.txt',
  );
  assert.equal(
    escapeGitReviewDisplayPath(
      Buffer.from([0x61, 0x5c, 0x78, 0x66, 0x66, 0x2d, 0xff, 0x0a]),
    ),
    'a\\\\xff-\\xff\\n',
  );
  assert.equal(
    escapeGitReviewDisplayPath(Buffer.from('safe\u202epath')),
    'safe\\xe2\\x80\\xaepath',
  );
});

void test('structured line diff preserves duplicate-line edits deterministically', () => {
  const rows = buildGitReviewDiffRows({
    sectionId: 'section-1',
    before: {
      lines: ['a', 'b', 'a'],
      endsWithNewline: true,
    },
    after: {
      lines: ['a', 'a', 'c'],
      endsWithNewline: true,
    },
  });

  assert.equal(rows[0]?.kind, 'hunk');
  assert.deepEqual(
    rows
      .filter((row) => row.kind !== 'hunk' && row.kind !== 'deletion')
      .map((row) => row.content),
    ['a', 'a', 'c'],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'deletion').map((row) => row.content),
    ['b'],
  );
  assert.deepEqual(
    buildGitReviewDiffRows({
      sectionId: 'section-1',
      before: { lines: ['same'], endsWithNewline: true },
      after: { lines: ['same'], endsWithNewline: true },
    }),
    [],
  );
});

void test('newline-only EOF changes remain visible in totals and file rows', async (t) => {
  const fixture = await createGitReviewFixture(t);
  const filePath = join(fixture.repositoryRoot, 'newline.txt');
  await writeFile(filePath, 'same');
  await runGit(fixture.repositoryRoot, ['add', 'newline.txt']);
  await runGit(fixture.repositoryRoot, ['commit', '-qm', 'baseline']);
  await writeFile(filePath, 'same\n');

  const service = createReviewService(fixture);
  const summary = await service.summary({
    kind: 'start',
    workingDirectory: fixture.repositoryRoot,
  });
  assert.equal(summary.kind, 'changed');
  if (summary.kind !== 'changed') {
    return;
  }
  assert.deepEqual(summary.totals, {
    fileCount: 1,
    additions: 1,
    deletions: 1,
    lineStatsComplete: true,
  });
  const file = summary.files.items[0];
  assert.ok(file);

  const result = await service.file({
    kind: 'start',
    observationId: summary.observationId,
    fileId: file.fileId,
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    return;
  }
  assert.deepEqual(
    result.rows.items.map((row) => [row.kind, row.content]),
    [
      ['hunk', '@@ -1 +1 @@'],
      ['deletion', 'same'],
      ['metadata', '\\ No newline at end of before file'],
      ['addition', 'same'],
    ],
  );
});

interface GitReviewFixture {
  host: ReturnType<typeof createCommandSessionHost>;
  repositoryRoot: string;
  stateRoot: string;
}

async function createGitReviewFixture(
  t: TestContext,
): Promise<GitReviewFixture> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'geulbat-git-review-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-git-review-state-'));
  const host = createCommandSessionHost({
    inlineMaxBytes: 1024 * 1024,
    tailRingBytes: 1024 * 1024,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });
  await runGit(repositoryRoot, ['init', '-q', '-b', 'main']);
  await runGit(repositoryRoot, ['config', 'user.name', 'Geulbat Test']);
  await runGit(repositoryRoot, [
    'config',
    'user.email',
    'geulbat@example.invalid',
  ]);
  return { host, repositoryRoot, stateRoot };
}

function createReviewService(
  fixture: GitReviewFixture,
  options: {
    coordinateBase?: string;
    pageLimitBytes?: number;
    maxOutputBytesPerStream?: number;
    maxFileBytes?: number;
  } = {},
) {
  let nextId = 0;
  return createGitReviewObservationService({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    ...(options.coordinateBase === undefined
      ? {}
      : { coordinateBase: options.coordinateBase }),
    pageLimitBytes: options.pageLimitBytes ?? 1024 * 1024,
    maxOutputBytesPerStream: options.maxOutputBytesPerStream ?? 1024 * 1024,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    cursorKey: Buffer.alloc(32, 7),
    createId: () => `id-${String((nextId += 1))}`,
    now: () => new Date('2026-07-29T15:00:00.000Z'),
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
