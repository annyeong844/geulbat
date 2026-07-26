import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  buildProductXHarnessSourceCandidate,
  buildProductXHarnessSourcePortfolioProposal,
  createProductXHarnessSourcePortfolioApproval,
  parseProductXHarnessSourcePortfolioProposal,
  publishProductXHarnessSourcePortfolio,
  recoverProductXHarnessSourceCandidateBuild,
  recoverProductXHarnessSourcePortfolioPublication,
} from './product-xharness-source-publication.js';

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'xHarness test',
  GIT_AUTHOR_EMAIL: 'xharness-test@example.invalid',
  GIT_COMMITTER_NAME: 'xHarness test',
  GIT_COMMITTER_EMAIL: 'xharness-test@example.invalid',
};

interface SourceFixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly baselineCommitId: string;
  readonly firstCandidateCommitId: string;
  readonly secondCandidateCommitId: string;
  readonly overlappingCandidateCommitId: string;
}

function digest(fill: string): `sha256:${string}` {
  return `sha256:${fill.repeat(64)}`;
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    env: GIT_ENV,
  });
  return result.stdout.trim();
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const targetPath = join(root, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents, 'utf8');
}

async function commitAll(root: string, message: string): Promise<string> {
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-m', message]);
  return await runGit(root, ['rev-parse', 'HEAD']);
}

async function createSourceFixture(): Promise<SourceFixture> {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-source-publication-test-'),
  );
  const root = join(fixtureRoot, 'repository');
  const stateRoot = join(fixtureRoot, 'state');
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '--initial-branch=main']);
  await writeFixtureFile(root, 'alpha.txt', 'alpha baseline\n');
  await writeFixtureFile(root, 'beta.txt', 'beta baseline\n');
  await writeFixtureFile(root, 'remove.txt', 'remove baseline\n');
  const baselineCommitId = await commitAll(root, 'baseline');

  await runGit(root, ['switch', '-c', 'candidate-one']);
  await writeFixtureFile(root, 'alpha.txt', 'alpha candidate\n');
  await writeFixtureFile(root, 'created.txt', 'created candidate\n');
  const firstCandidateCommitId = await commitAll(root, 'candidate one');

  await runGit(root, ['switch', '-c', 'candidate-two', baselineCommitId]);
  await writeFixtureFile(root, 'beta.txt', 'beta candidate\n');
  await rm(join(root, 'remove.txt'));
  const secondCandidateCommitId = await commitAll(root, 'candidate two');

  await runGit(root, ['switch', '-c', 'candidate-overlap', baselineCommitId]);
  await writeFixtureFile(root, 'alpha.txt', 'overlapping candidate\n');
  const overlappingCandidateCommitId = await commitAll(
    root,
    'candidate overlap',
  );

  await runGit(root, ['switch', 'main']);
  return {
    root,
    stateRoot,
    baselineCommitId,
    firstCandidateCommitId,
    secondCandidateCommitId,
    overlappingCandidateCommitId,
  };
}

async function buildProposal(
  fixture: SourceFixture,
  portfolioDecisionDigest: `sha256:${string}` = digest('a'),
) {
  return await buildProductXHarnessSourcePortfolioProposal({
    repositoryRoot: fixture.root,
    baselineCommitId: fixture.baselineCommitId,
    portfolioDecisionDigest,
    candidates: [
      {
        candidateId: 'candidate-one',
        buckets: ['tools'],
        decisionDigest: digest('b'),
        packetDigest: digest('c'),
        qualificationReceiptDigest: null,
        candidateCommitId: fixture.firstCandidateCommitId,
        expectedFileChanges: [
          { path: 'alpha.txt', action: 'modify' },
          { path: 'created.txt', action: 'create' },
        ],
      },
      {
        candidateId: 'candidate-two',
        buckets: ['config'],
        decisionDigest: digest('d'),
        packetDigest: digest('e'),
        qualificationReceiptDigest: null,
        candidateCommitId: fixture.secondCandidateCommitId,
        expectedFileChanges: [
          { path: 'beta.txt', action: 'modify' },
          { path: 'remove.txt', action: 'delete' },
        ],
      },
    ],
  });
}

void test('builds and recovers one manifest-bound Git candidate without changing the worktree, index, branch, or HEAD', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const candidateSourceRoot = join(dirname(fixture.root), 'candidate-source');
  await writeFixtureFile(
    candidateSourceRoot,
    'alpha.txt',
    'alpha built candidate\n',
  );
  await writeFixtureFile(
    candidateSourceRoot,
    'created.txt',
    'created built candidate\n',
  );
  const packetDigest = digest('1');
  const plan = {
    schemaVersion: 1,
    planKind: 'xharness_git_source_candidate',
    candidateId: 'candidate-built',
    packetDigest,
    operations: [
      { action: 'delete', path: 'remove.txt' },
      {
        action: 'modify',
        path: 'alpha.txt',
        mode: '100644',
      },
      {
        action: 'create',
        path: 'created.txt',
        mode: '100644',
      },
    ],
  };
  const beforeHead = await runGit(fixture.root, ['rev-parse', 'HEAD']);
  const beforeTree = await runGit(fixture.root, ['write-tree']);

  const first = await buildProductXHarnessSourceCandidate({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    candidateSourceRoot,
    baselineCommitId: fixture.baselineCommitId,
    candidateId: 'candidate-built',
    packetDigest,
    expectedFileChanges: [
      { path: 'alpha.txt', action: 'modify' },
      { path: 'created.txt', action: 'create' },
      { path: 'remove.txt', action: 'delete' },
    ],
    plan,
  });

  assert.equal(first.created, true);
  assert.equal(
    await runGit(fixture.root, [
      'show',
      `${first.receipt.candidateCommitId}:alpha.txt`,
    ]),
    'alpha built candidate',
  );
  assert.equal(
    await runGit(fixture.root, [
      'show',
      `${first.receipt.candidateCommitId}:created.txt`,
    ]),
    'created built candidate',
  );
  await assert.rejects(
    runGit(fixture.root, [
      'cat-file',
      '-e',
      `${first.receipt.candidateCommitId}:remove.txt`,
    ]),
  );
  assert.equal(
    await runGit(fixture.root, ['rev-parse', first.receipt.candidateRef]),
    first.receipt.candidateCommitId,
  );
  assert.equal(await runGit(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(await runGit(fixture.root, ['write-tree']), beforeTree);
  assert.equal(
    await runGit(fixture.root, ['branch', '--show-current']),
    'main',
  );
  assert.equal(await runGit(fixture.root, ['status', '--porcelain']), '');

  const repeated = await buildProductXHarnessSourceCandidate({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    candidateSourceRoot,
    baselineCommitId: fixture.baselineCommitId,
    candidateId: 'candidate-built',
    packetDigest,
    expectedFileChanges: [
      { path: 'alpha.txt', action: 'modify' },
      { path: 'created.txt', action: 'create' },
      { path: 'remove.txt', action: 'delete' },
    ],
    plan,
  });
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.receipt, first.receipt);

  await writeFixtureFile(
    candidateSourceRoot,
    'alpha.txt',
    'another implementation for the same packet\n',
  );
  await assert.rejects(
    buildProductXHarnessSourceCandidate({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      candidateSourceRoot,
      baselineCommitId: fixture.baselineCommitId,
      candidateId: 'candidate-built',
      packetDigest,
      expectedFileChanges: [
        { path: 'alpha.txt', action: 'modify' },
        { path: 'created.txt', action: 'create' },
        { path: 'remove.txt', action: 'delete' },
      ],
      plan,
    }),
    /packet ref already names another Git candidate/u,
  );

  await runGit(fixture.root, ['update-ref', '-d', first.receipt.candidateRef]);
  const recovered = await recoverProductXHarnessSourceCandidateBuild({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    receiptDigest: first.receipt.receiptDigest,
  });
  assert.deepEqual(recovered, first.receipt);
  assert.equal(
    await runGit(fixture.root, ['rev-parse', first.receipt.candidateRef]),
    first.receipt.candidateCommitId,
  );
});

void test('rejects candidate plans that disagree with the admitted manifest or escape through source symlinks', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const candidateSourceRoot = join(dirname(fixture.root), 'candidate-source');
  await mkdir(candidateSourceRoot, { recursive: true });
  const packetDigest = digest('2');

  await assert.rejects(
    buildProductXHarnessSourceCandidate({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      candidateSourceRoot,
      baselineCommitId: fixture.baselineCommitId,
      candidateId: 'candidate-mismatch',
      packetDigest,
      expectedFileChanges: [{ path: 'alpha.txt', action: 'modify' }],
      plan: {
        schemaVersion: 1,
        planKind: 'xharness_git_source_candidate',
        candidateId: 'candidate-mismatch',
        packetDigest,
        operations: [{ action: 'delete', path: 'alpha.txt' }],
      },
    }),
    /does not match its admitted file changes/u,
  );

  await symlink(
    join(fixture.root, 'alpha.txt'),
    join(candidateSourceRoot, 'alpha.txt'),
  );
  await assert.rejects(
    buildProductXHarnessSourceCandidate({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      candidateSourceRoot,
      baselineCommitId: fixture.baselineCommitId,
      candidateId: 'candidate-symlink',
      packetDigest,
      expectedFileChanges: [{ path: 'alpha.txt', action: 'modify' }],
      plan: {
        schemaVersion: 1,
        planKind: 'xharness_git_source_candidate',
        candidateId: 'candidate-symlink',
        packetDigest,
        operations: [
          {
            action: 'modify',
            path: 'alpha.txt',
            mode: '100644',
          },
        ],
      },
    }),
    /must be a regular file below candidateSourceRoot/u,
  );
});

void test('builds an executable path-disjoint Git tree without changing the working branch', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });

  const proposal = await buildProposal(fixture);

  assert.equal(
    await runGit(fixture.root, [
      'show',
      `${proposal.composedTreeId}:alpha.txt`,
    ]),
    'alpha candidate',
  );
  assert.equal(
    await runGit(fixture.root, ['show', `${proposal.composedTreeId}:beta.txt`]),
    'beta candidate',
  );
  assert.equal(
    await runGit(fixture.root, [
      'show',
      `${proposal.composedTreeId}:created.txt`,
    ]),
    'created candidate',
  );
  await assert.rejects(
    runGit(fixture.root, [
      'cat-file',
      '-e',
      `${proposal.composedTreeId}:remove.txt`,
    ]),
  );
  assert.equal(
    await runGit(fixture.root, ['branch', '--show-current']),
    'main',
  );
  assert.equal(await runGit(fixture.root, ['status', '--porcelain']), '');
  assert.deepEqual(
    parseProductXHarnessSourcePortfolioProposal(proposal),
    proposal,
  );
});

void test('fails closed when the executable Git diff disagrees with approval scope or overlaps another candidate', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });

  await assert.rejects(
    buildProductXHarnessSourcePortfolioProposal({
      repositoryRoot: fixture.root,
      baselineCommitId: fixture.baselineCommitId,
      portfolioDecisionDigest: digest('a'),
      candidates: [
        {
          candidateId: 'candidate-one',
          buckets: ['tools'],
          decisionDigest: digest('b'),
          packetDigest: digest('c'),
          qualificationReceiptDigest: null,
          candidateCommitId: fixture.firstCandidateCommitId,
          expectedFileChanges: [{ path: 'alpha.txt', action: 'modify' }],
        },
      ],
    }),
    /does not match its approved file_changes/u,
  );

  await assert.rejects(
    buildProductXHarnessSourcePortfolioProposal({
      repositoryRoot: fixture.root,
      baselineCommitId: fixture.baselineCommitId,
      portfolioDecisionDigest: digest('a'),
      candidates: [
        {
          candidateId: 'candidate-one',
          buckets: ['tools'],
          decisionDigest: digest('b'),
          packetDigest: digest('c'),
          qualificationReceiptDigest: null,
          candidateCommitId: fixture.firstCandidateCommitId,
          expectedFileChanges: [
            { path: 'alpha.txt', action: 'modify' },
            { path: 'created.txt', action: 'create' },
          ],
        },
        {
          candidateId: 'candidate-overlap',
          buckets: ['prompt'],
          decisionDigest: digest('d'),
          packetDigest: digest('e'),
          qualificationReceiptDigest: null,
          candidateCommitId: fixture.overlappingCandidateCommitId,
          expectedFileChanges: [{ path: 'alpha.txt', action: 'modify' }],
        },
      ],
    }),
    /duplicate path across source portfolio candidates/u,
  );
});

void test('publishes an approved tree to an isolated CAS ref and recovers missing derived artifacts', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const proposal = await buildProposal(fixture);
  const approval = createProductXHarnessSourcePortfolioApproval({
    proposal,
    decisionType: 'publish',
    authorityIdentity: digest('f'),
  });
  const publicationRef = 'refs/geulbat/xharness/source/active/integration-test';

  const first = await publishProductXHarnessSourcePortfolio({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    publicationRef,
    proposal,
    approval,
  });
  assert.equal(first.created, true);
  assert.equal(
    await runGit(fixture.root, ['rev-parse', publicationRef]),
    first.receipt.publicationCommitId,
  );
  assert.equal(
    await runGit(fixture.root, [
      'show',
      '-s',
      '--format=%T',
      first.receipt.publicationCommitId,
    ]),
    proposal.composedTreeId,
  );
  assert.equal(
    await runGit(fixture.root, ['branch', '--show-current']),
    'main',
  );
  assert.equal(await runGit(fixture.root, ['status', '--porcelain']), '');

  const repeated = await publishProductXHarnessSourcePortfolio({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    publicationRef,
    proposal,
    approval,
  });
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.receipt, first.receipt);

  const sourceStateRoot = join(
    fixture.stateRoot,
    '.geulbat',
    'xharness',
    'source-publication',
  );
  await rm(join(sourceStateRoot, 'archives'), { recursive: true, force: true });
  await rm(join(sourceStateRoot, 'receipts'), { recursive: true, force: true });
  await rm(join(sourceStateRoot, 'by-approval'), {
    recursive: true,
    force: true,
  });
  const recovered = await recoverProductXHarnessSourcePortfolioPublication({
    repositoryRoot: fixture.root,
    stateRoot: fixture.stateRoot,
    publicationRef,
    approvalDigest: approval.approvalDigest,
  });
  assert.equal(recovered.created, true);
  assert.deepEqual(recovered.receipt, first.receipt);
});

void test('rejects non-publish authority and a publication ref that advanced from the approved baseline', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const proposal = await buildProposal(fixture);
  const rejected = createProductXHarnessSourcePortfolioApproval({
    proposal,
    decisionType: 'reject',
    authorityIdentity: digest('f'),
  });
  const publicationRef = 'refs/geulbat/xharness/source/active/conflict-test';

  await assert.rejects(
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal,
      approval: rejected,
    }),
    /requires publish approval/u,
  );

  await runGit(fixture.root, [
    'update-ref',
    publicationRef,
    fixture.firstCandidateCommitId,
  ]);
  const approved = createProductXHarnessSourcePortfolioApproval({
    proposal,
    decisionType: 'publish',
    authorityIdentity: digest('f'),
  });
  await assert.rejects(
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal,
      approval: approved,
    }),
    /no longer matches the approved baseline/u,
  );
  await assert.rejects(
    runGit(fixture.root, [
      'show-ref',
      '--verify',
      `refs/geulbat/xharness/source/publications/${approved.approvalDigest.slice(
        'sha256:'.length,
      )}`,
    ]),
  );
});

void test('makes concurrent identical publication idempotent without exposing two Git states', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const proposal = await buildProposal(fixture);
  const approval = createProductXHarnessSourcePortfolioApproval({
    proposal,
    decisionType: 'publish',
    authorityIdentity: digest('f'),
  });
  const publicationRef =
    'refs/geulbat/xharness/source/active/concurrent-identical';

  const publications = await Promise.all([
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal,
      approval,
    }),
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal,
      approval,
    }),
  ]);

  assert.deepEqual(publications.map(({ created }) => created).sort(), [
    false,
    true,
  ]);
  assert.deepEqual(publications[0]?.receipt, publications[1]?.receipt);
  assert.equal(
    await runGit(fixture.root, ['rev-parse', publicationRef]),
    publications[0]?.receipt.publicationCommitId,
  );
});

void test('admits only one concurrent approved publication for the same baseline ref', async (t) => {
  const fixture = await createSourceFixture();
  t.after(async () => {
    await rm(dirname(fixture.root), { recursive: true, force: true });
  });
  const firstProposal = await buildProposal(fixture);
  const secondProposal = await buildProposal(fixture, digest('0'));
  const firstApproval = createProductXHarnessSourcePortfolioApproval({
    proposal: firstProposal,
    decisionType: 'publish',
    authorityIdentity: digest('f'),
  });
  const secondApproval = createProductXHarnessSourcePortfolioApproval({
    proposal: secondProposal,
    decisionType: 'publish',
    authorityIdentity: digest('1'),
  });
  const publicationRef =
    'refs/geulbat/xharness/source/active/concurrent-different';

  const results = await Promise.allSettled([
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal: firstProposal,
      approval: firstApproval,
    }),
    publishProductXHarnessSourcePortfolio({
      repositoryRoot: fixture.root,
      stateRoot: fixture.stateRoot,
      publicationRef,
      proposal: secondProposal,
      approval: secondApproval,
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  );
  const published = results.find((result) => result.status === 'fulfilled');
  assert.equal(
    await runGit(fixture.root, ['rev-parse', publicationRef]),
    published?.value.receipt.publicationCommitId,
  );

  const recordRefs = await Promise.allSettled(
    [firstApproval, secondApproval].map(async (approval) => {
      return await runGit(fixture.root, [
        'show-ref',
        '--verify',
        `refs/geulbat/xharness/source/publications/${approval.approvalDigest.slice(
          'sha256:'.length,
        )}`,
      ]);
    }),
  );
  assert.equal(
    recordRefs.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    recordRefs.filter((result) => result.status === 'rejected').length,
    1,
  );
});
