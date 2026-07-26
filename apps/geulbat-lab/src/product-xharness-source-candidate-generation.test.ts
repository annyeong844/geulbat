import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import {
  buildProductXHarnessModelSourceCandidate,
  createProductXHarnessSourceCandidateModelProposal,
  createProductXHarnessSourceCandidateModelRequest,
  parseProductXHarnessSourceCandidateGenerationBrief,
  parseProductXHarnessSourceCandidateVerificationPlan,
  recoverProductXHarnessSourceCandidateQualification,
  verifyProductXHarnessSourceCandidate,
  type ProductXHarnessSourceCandidateVerificationPlan,
} from './product-xharness-source-candidate-generation.js';

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'xHarness generation test',
  GIT_AUTHOR_EMAIL: 'xharness-generation@example.invalid',
  GIT_COMMITTER_NAME: 'xHarness generation test',
  GIT_COMMITTER_EMAIL: 'xharness-generation@example.invalid',
};

interface GenerationFixture {
  readonly fixtureRoot: string;
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly baselineCommitId: string;
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
  contents: string | Buffer,
): Promise<void> {
  const targetPath = join(root, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents);
}

async function createGenerationFixture(): Promise<GenerationFixture> {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-source-generation-test-'),
  );
  const repositoryRoot = join(fixtureRoot, 'repository');
  const stateRoot = join(fixtureRoot, 'state');
  await mkdir(repositoryRoot, { recursive: true });
  await runGit(repositoryRoot, ['init', '--initial-branch=main']);
  await writeFixtureFile(repositoryRoot, 'alpha.txt', 'alpha baseline\n');
  await writeFixtureFile(
    repositoryRoot,
    'context/guide.txt',
    'guide baseline\n',
  );
  await writeFixtureFile(repositoryRoot, 'retired.txt', 'retired baseline\n');
  await symlink('alpha.txt', join(repositoryRoot, 'linked-alpha.txt'));
  await runGit(repositoryRoot, ['add', '--all']);
  await runGit(repositoryRoot, ['commit', '-m', 'baseline']);
  return {
    fixtureRoot,
    repositoryRoot,
    stateRoot,
    baselineCommitId: await runGit(repositoryRoot, ['rev-parse', 'HEAD']),
  };
}

function createBrief(packetDigest: `sha256:${string}`) {
  return parseProductXHarnessSourceCandidateGenerationBrief({
    schemaVersion: 1,
    briefKind: 'xharness_source_candidate_generation',
    candidateId: 'candidate-model',
    packetDigest,
    instructions: 'Update alpha, create beta, and remove retired.',
    contextPaths: ['context/guide.txt'],
  });
}

function expectedChanges() {
  return [
    { path: 'alpha.txt', action: 'modify' as const },
    { path: 'beta.txt', action: 'create' as const },
    { path: 'retired.txt', action: 'delete' as const },
  ];
}

function createSubmission(packetDigest: `sha256:${string}`) {
  return {
    schemaVersion: 1,
    candidateId: 'candidate-model',
    packetDigest,
    operations: [
      {
        action: 'create',
        path: 'beta.txt',
        mode: '100644',
        content: 'beta candidate\n',
      },
      {
        action: 'delete',
        path: 'retired.txt',
      },
      {
        action: 'modify',
        path: 'alpha.txt',
        mode: '100644',
        content: 'alpha candidate\n',
      },
    ],
  };
}

function createVerificationPlan(
  packetDigest: `sha256:${string}`,
): ProductXHarnessSourceCandidateVerificationPlan {
  return parseProductXHarnessSourceCandidateVerificationPlan({
    schemaVersion: 1,
    planKind: 'xharness_source_candidate_verification',
    candidateId: 'candidate-model',
    packetDigest,
    commands: [
      {
        commandId: 'typecheck',
        argv: ['npm', 'run', 'check'],
        timeoutMs: 60_000,
      },
      {
        commandId: 'tests',
        argv: ['npm', 'test'],
        timeoutMs: 120_000,
      },
    ],
  });
}

function sandboxIdentity() {
  return {
    executionSurface: 'ptc_local_docker' as const,
    policyDigest: digest('9'),
    imageRef: 'local/geulbat-ptc-session:test',
    imagePolicyId: 'ptc_session_docker_image_local_pinned_v1',
    networkMode: 'none' as const,
    packageCachePolicyId: 'caller_read_only_npm_cache_v1' as const,
    packageLockDigest: digest('8'),
    cpus: '2',
    memory: '2g',
    pidsLimit: '256',
  };
}

async function buildModelCandidate(fixture: GenerationFixture) {
  const packetDigest = digest('1');
  const request = await createProductXHarnessSourceCandidateModelRequest({
    repositoryRoot: fixture.repositoryRoot,
    baselineRevision: fixture.baselineCommitId,
    candidateId: 'candidate-model',
    packetDigest,
    changeManifest: {
      candidate_id: 'candidate-model',
      file_changes: expectedChanges(),
    },
    expectedFileChanges: expectedChanges(),
    brief: createBrief(packetDigest),
  });
  const build = await buildProductXHarnessModelSourceCandidate({
    repositoryRoot: fixture.repositoryRoot,
    stateRoot: fixture.stateRoot,
    baselineCommitId: fixture.baselineCommitId,
    candidateId: 'candidate-model',
    packetDigest,
    expectedFileChanges: expectedChanges(),
    modelConfigId: digest('2'),
    modelRequest: request,
    submission: createSubmission(packetDigest),
  });
  return { packetDigest, request, build };
}

void test('builds the exact model proposal from baseline Git sources without touching current worktree state', async (t) => {
  const fixture = await createGenerationFixture();
  t.after(async () => {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  });
  await writeFixtureFile(
    fixture.repositoryRoot,
    'alpha.txt',
    'uncommitted alpha\n',
  );
  await writeFixtureFile(fixture.repositoryRoot, 'local-only.txt', 'local\n');
  const beforeStatus = await runGit(fixture.repositoryRoot, [
    'status',
    '--porcelain',
  ]);

  const { request, build } = await buildModelCandidate(fixture);

  assert.deepEqual(
    request.sources.map(({ path, content }) => ({ path, content })),
    [
      { path: 'alpha.txt', content: 'alpha baseline\n' },
      { path: 'context/guide.txt', content: 'guide baseline\n' },
      { path: 'retired.txt', content: 'retired baseline\n' },
    ],
  );
  assert.equal(
    await runGit(fixture.repositoryRoot, [
      'show',
      `${build.build.receipt.candidateCommitId}:alpha.txt`,
    ]),
    'alpha candidate',
  );
  assert.equal(
    await runGit(fixture.repositoryRoot, [
      'show',
      `${build.build.receipt.candidateCommitId}:beta.txt`,
    ]),
    'beta candidate',
  );
  await assert.rejects(
    runGit(fixture.repositoryRoot, [
      'cat-file',
      '-e',
      `${build.build.receipt.candidateCommitId}:retired.txt`,
    ]),
  );
  assert.equal(
    await runGit(fixture.repositoryRoot, ['status', '--porcelain']),
    beforeStatus,
  );
  assert.equal(
    await runGit(fixture.repositoryRoot, ['branch', '--show-current']),
    'main',
  );
});

void test('rejects baseline source indirection and model operations outside the admitted manifest', async (t) => {
  const fixture = await createGenerationFixture();
  t.after(async () => {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  });
  const packetDigest = digest('3');

  await assert.rejects(
    createProductXHarnessSourceCandidateModelRequest({
      repositoryRoot: fixture.repositoryRoot,
      baselineRevision: fixture.baselineCommitId,
      candidateId: 'candidate-model',
      packetDigest,
      changeManifest: {},
      expectedFileChanges: expectedChanges(),
      brief: parseProductXHarnessSourceCandidateGenerationBrief({
        schemaVersion: 1,
        briefKind: 'xharness_source_candidate_generation',
        candidateId: 'candidate-model',
        packetDigest,
        instructions: 'Read the linked source.',
        contextPaths: ['linked-alpha.txt'],
      }),
    }),
    /must be a regular UTF-8 file/u,
  );

  assert.throws(
    () =>
      createProductXHarnessSourceCandidateModelProposal({
        candidateId: 'candidate-model',
        packetDigest,
        modelConfigId: digest('4'),
        modelRequestDigest: digest('5'),
        expectedFileChanges: expectedChanges(),
        submission: {
          ...createSubmission(packetDigest),
          operations: [
            ...createSubmission(packetDigest).operations,
            {
              action: 'create',
              path: 'surprise.txt',
              mode: '100644',
              content: 'not admitted\n',
            },
          ],
        },
      }),
    /do not match admitted file changes/u,
  );
});

void test('qualifies sequential commands, retains exact output bytes, and recovers the model-bound receipt', async (t) => {
  const fixture = await createGenerationFixture();
  t.after(async () => {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  });
  const { packetDigest, build } = await buildModelCandidate(fixture);
  const plan = createVerificationPlan(packetDigest);
  const calls: string[] = [];
  const qualification = await verifyProductXHarnessSourceCandidate({
    stateRoot: fixture.stateRoot,
    buildReceipt: build.build.receipt,
    sourceOrigin: {
      kind: 'model_proposal',
      proposal: build.proposal,
    },
    plan,
    sandbox: sandboxIdentity(),
    async runCommand(command) {
      calls.push(command.commandId);
      return {
        status: 'exit',
        exitCode: 0,
        stdout:
          command.commandId === 'typecheck'
            ? Buffer.from([0x6f, 0x6b, 0x0a])
            : Buffer.from([0xff, 0x00, 0x7f]),
        stderr: Buffer.alloc(0),
      };
    },
  });

  assert.deepEqual(calls, ['typecheck', 'tests']);
  assert.equal(qualification.receipt.qualified, true);
  assert.equal(
    qualification.receipt.commandOutcomes[1]?.stdoutBase64,
    Buffer.from([0xff, 0x00, 0x7f]).toString('base64'),
  );
  assert.deepEqual(
    await recoverProductXHarnessSourceCandidateQualification({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      qualificationReceiptDigest:
        qualification.receipt.qualificationReceiptDigest,
    }),
    qualification.receipt,
  );
});

void test('stops on the first failed verification command and retains a recoverable failure receipt', async (t) => {
  const fixture = await createGenerationFixture();
  t.after(async () => {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  });
  const { packetDigest, build } = await buildModelCandidate(fixture);
  const plan = createVerificationPlan(packetDigest);
  const calls: string[] = [];
  const qualification = await verifyProductXHarnessSourceCandidate({
    stateRoot: fixture.stateRoot,
    buildReceipt: build.build.receipt,
    sourceOrigin: {
      kind: 'explicit_plan',
      digest: build.build.receipt.planDigest,
    },
    plan,
    sandbox: sandboxIdentity(),
    async runCommand(command) {
      calls.push(command.commandId);
      return {
        status: 'exit',
        exitCode: command.commandId === 'typecheck' ? 1 : 0,
        stdout: Buffer.from('stdout\n'),
        stderr: Buffer.from('failed\n'),
      };
    },
  });

  assert.deepEqual(calls, ['typecheck']);
  assert.equal(qualification.receipt.qualified, false);
  assert.equal(qualification.receipt.commandOutcomes.length, 1);
  assert.deepEqual(
    await recoverProductXHarnessSourceCandidateQualification({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      qualificationReceiptDigest:
        qualification.receipt.qualificationReceiptDigest,
    }),
    qualification.receipt,
  );
});

void test('recovery rejects a digest-valid receipt whose command outcomes do not reproduce plan order', async (t) => {
  const fixture = await createGenerationFixture();
  t.after(async () => {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  });
  const { packetDigest, build } = await buildModelCandidate(fixture);
  const qualification = await verifyProductXHarnessSourceCandidate({
    stateRoot: fixture.stateRoot,
    buildReceipt: build.build.receipt,
    sourceOrigin: {
      kind: 'model_proposal',
      proposal: build.proposal,
    },
    plan: createVerificationPlan(packetDigest),
    sandbox: sandboxIdentity(),
    async runCommand() {
      return {
        status: 'exit',
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    },
  });
  const { qualificationReceiptDigest: _originalDigest, ...originalBody } =
    qualification.receipt;
  const tamperedBody = {
    ...originalBody,
    commandOutcomes: [...originalBody.commandOutcomes].reverse(),
  };
  const tamperedDigest =
    `sha256:${sha256StableJson(tamperedBody)}` as `sha256:${string}`;
  const tamperedPath = join(
    fixture.stateRoot,
    '.geulbat',
    'xharness',
    'source-generation',
    'qualification-receipts',
    `${tamperedDigest.slice('sha256:'.length)}.json`,
  );
  await mkdir(dirname(tamperedPath), { recursive: true });
  await writeFile(
    tamperedPath,
    JSON.stringify({
      ...tamperedBody,
      qualificationReceiptDigest: tamperedDigest,
    }),
    'utf8',
  );

  await assert.rejects(
    recoverProductXHarnessSourceCandidateQualification({
      repositoryRoot: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      qualificationReceiptDigest: tamperedDigest,
    }),
    /does not reproduce its verification command order/u,
  );
  assert.equal(
    JSON.parse(await readFile(tamperedPath, 'utf8')).qualificationReceiptDigest,
    tamperedDigest,
  );
});
