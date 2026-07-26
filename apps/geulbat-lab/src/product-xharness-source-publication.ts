import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

import { publishProductXHarnessImmutableJson } from '@geulbat/product/immutable-publication';
import {
  assertExactPlainRecord,
  isErrorCode,
  readDigest,
  readNonEmptyString,
  readObjectId,
  readRepositoryRelativePath,
  readRequiredJson,
  type Sha256Digest,
} from '@geulbat/product/cli-support';

type SourceChangeAction = 'create' | 'modify' | 'delete';

export interface ProductXHarnessExpectedSourceChange {
  readonly path: string;
  readonly action: SourceChangeAction;
}

interface ProductXHarnessSourceCandidateAuthority {
  readonly candidateId: string;
  readonly buckets: readonly string[];
  readonly decisionDigest: Sha256Digest;
  readonly packetDigest: Sha256Digest;
  readonly qualificationReceiptDigest: Sha256Digest | null;
  readonly candidateCommitId: string;
  readonly expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[];
}

interface ProductXHarnessSourceChange {
  readonly path: string;
  readonly action: SourceChangeAction;
  readonly baselineObjectId: string | null;
  readonly candidateObjectId: string | null;
  readonly baselineMode: string | null;
  readonly candidateMode: string | null;
}

interface ProductXHarnessSourceCandidate {
  readonly candidateId: string;
  readonly buckets: readonly string[];
  readonly decisionDigest: Sha256Digest;
  readonly packetDigest: Sha256Digest;
  readonly qualificationReceiptDigest: Sha256Digest | null;
  readonly baselineCommitId: string;
  readonly baselineTreeId: string;
  readonly candidateCommitId: string;
  readonly candidateTreeId: string;
  readonly changes: readonly ProductXHarnessSourceChange[];
  readonly sourceCandidateDigest: Sha256Digest;
}

interface ProductXHarnessSourcePortfolioProposal {
  readonly schemaVersion: 1;
  readonly proposalKind: 'xharness_git_source_portfolio';
  readonly portfolioDecisionDigest: Sha256Digest;
  readonly repositoryObjectFormat: string;
  readonly baselineCommitId: string;
  readonly baselineTreeId: string;
  readonly candidates: readonly ProductXHarnessSourceCandidate[];
  readonly composedTreeId: string;
  readonly proposalDigest: Sha256Digest;
}

interface ProductXHarnessSourcePortfolioApproval {
  readonly schemaVersion: 1;
  readonly approvalKind: 'xharness_git_source_portfolio';
  readonly proposalDigest: Sha256Digest;
  readonly decisionType: 'publish' | 'reject';
  readonly authorityIdentity: Sha256Digest;
  readonly approvalDigest: Sha256Digest;
}

interface ProductXHarnessSourcePublicationReceipt {
  readonly schemaVersion: 1;
  readonly receiptKind: 'xharness_git_source_publication';
  readonly proposalDigest: Sha256Digest;
  readonly approvalDigest: Sha256Digest;
  readonly portfolioDecisionDigest: Sha256Digest;
  readonly baselineCommitId: string;
  readonly composedTreeId: string;
  readonly publicationCommitId: string;
  readonly publicationRef: string;
  readonly candidateSourceDigests: readonly Sha256Digest[];
  readonly archiveFormat: 'tar';
  readonly archiveDigest: Sha256Digest;
  readonly archiveBytes: number;
  readonly publicationReceiptDigest: Sha256Digest;
}

type ProductXHarnessSourceCandidateBuildOperation =
  | {
      readonly action: 'create' | 'modify';
      readonly path: string;
      readonly mode: '100644' | '100755';
    }
  | {
      readonly action: 'delete';
      readonly path: string;
    };

export interface ProductXHarnessSourceCandidateBuildPlan {
  readonly schemaVersion: 1;
  readonly planKind: 'xharness_git_source_candidate';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly operations: readonly ProductXHarnessSourceCandidateBuildOperation[];
  readonly planDigest: Sha256Digest;
}

export interface ProductXHarnessSourceCandidateBuildReceipt {
  readonly schemaVersion: 1;
  readonly receiptKind: 'xharness_git_source_candidate_build';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly repositoryObjectFormat: string;
  readonly baselineCommitId: string;
  readonly baselineTreeId: string;
  readonly candidateTreeId: string;
  readonly candidateCommitId: string;
  readonly candidateRef: string;
  readonly changes: readonly ProductXHarnessSourceChange[];
  readonly receiptDigest: Sha256Digest;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface GitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
}

const SOURCE_PUBLICATION_DIRECTORY = [
  '.geulbat',
  'xharness',
  'source-publication',
] as const;
const SOURCE_PUBLICATION_REF_PREFIX = 'refs/geulbat/xharness/source/active/';
const SOURCE_PUBLICATION_RECORD_REF_PREFIX =
  'refs/geulbat/xharness/source/publications/';
const SOURCE_CANDIDATE_REF_PREFIX =
  'refs/geulbat/xharness/source/candidate-packets/';
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GIT_RAW_DIFF_HEADER_PATTERN =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/u;
const SUPPORTED_FILE_MODES = new Set(['100644', '100755', '120000']);
const ZERO_MODE = '000000';

export async function resolveProductXHarnessGitCommit(
  repositoryRoot: string,
  revision: string,
): Promise<string> {
  const normalizedRevision = readNonEmptyString(revision, 'revision');
  const result = await runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${normalizedRevision}^{commit}`,
  ]);
  return readObjectId(decodeGitText(result.stdout).trim(), 'resolved commit');
}

export function parseProductXHarnessSourceCandidateBuildPlan(
  value: unknown,
): ProductXHarnessSourceCandidateBuildPlan {
  const record = assertExactPlainRecord(
    value,
    ['schemaVersion', 'planKind', 'candidateId', 'packetDigest', 'operations'],
    'source candidate build plan',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported source candidate build plan schemaVersion');
  }
  if (record.planKind !== 'xharness_git_source_candidate') {
    throw new Error('unsupported source candidate build plan kind');
  }
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error(
      'source candidate build plan requires at least one operation',
    );
  }
  const seenPaths = new Set<string>();
  const operations = record.operations.map((value, index) => {
    const operation = assertSourceCandidateBuildOperation(value, index);
    assertUnique(seenPaths, operation.path, 'source candidate operation path');
    return operation;
  });
  operations.sort((left, right) => left.path.localeCompare(right.path));
  const body = Object.freeze({
    schemaVersion: 1 as const,
    planKind: 'xharness_git_source_candidate' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    operations: Object.freeze(operations),
  });
  return Object.freeze({
    ...body,
    planDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
}

export async function buildProductXHarnessSourceCandidate(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly candidateSourceRoot: string;
  readonly baselineCommitId: string;
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[];
  readonly plan: unknown;
}): Promise<{
  readonly receipt: ProductXHarnessSourceCandidateBuildReceipt;
  readonly created: boolean;
}> {
  const repositoryRoot = readNonEmptyString(
    input.repositoryRoot,
    'repositoryRoot',
  );
  const stateRoot = readNonEmptyString(input.stateRoot, 'stateRoot');
  const candidateId = readCandidateId(input.candidateId);
  const packetDigest = readDigest(input.packetDigest, 'packetDigest');
  const plan = parseProductXHarnessSourceCandidateBuildPlan(input.plan);
  if (plan.candidateId !== candidateId || plan.packetDigest !== packetDigest) {
    throw new Error(
      'source candidate build plan does not identify its admitted packet',
    );
  }
  assertBuildPlanMatchesExpectedChanges(
    input.expectedFileChanges,
    plan.operations,
  );
  const candidateSourceRoot = await resolveCandidateSourceRoot(
    input.candidateSourceRoot,
  );
  const baselineCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    input.baselineCommitId,
  );
  const repositoryObjectFormat = readNonEmptyString(
    decodeGitText(
      (await runGit(repositoryRoot, ['rev-parse', '--show-object-format']))
        .stdout,
    ).trim(),
    'repository object format',
  );
  const baselineTreeId = await readCommitTreeId(
    repositoryRoot,
    baselineCommitId,
  );
  const candidateTreeId = await buildSourceCandidateTree({
    repositoryRoot,
    candidateSourceRoot,
    baselineCommitId,
    operations: plan.operations,
  });
  if (candidateTreeId === baselineTreeId) {
    throw new Error('source candidate build produced no Git tree change');
  }
  const commitRecord = Object.freeze({
    schemaVersion: 1 as const,
    commitKind: 'xharness_git_source_candidate' as const,
    candidateId,
    packetDigest,
    planDigest: plan.planDigest,
    repositoryObjectFormat,
    baselineCommitId,
    baselineTreeId,
    candidateTreeId,
  });
  const candidateCommitId = await createDeterministicSourceCommit({
    repositoryRoot,
    treeId: candidateTreeId,
    baselineCommitId,
    commitRecord,
  });
  const changes = await readSourceChanges(
    repositoryRoot,
    baselineCommitId,
    candidateCommitId,
  );
  assertExpectedChanges(input.expectedFileChanges, changes);
  const candidateRef = sourceCandidateRef(packetDigest);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_git_source_candidate_build' as const,
    candidateId,
    packetDigest,
    planDigest: plan.planDigest,
    repositoryObjectFormat,
    baselineCommitId,
    baselineTreeId,
    candidateTreeId,
    candidateCommitId,
    candidateRef,
    changes,
  });
  const receipt = Object.freeze({
    ...body,
    receiptDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: sourceCandidateReceiptPath(stateRoot, receipt.receiptDigest),
    pendingDirectory: sourcePendingDirectory(stateRoot),
    value: receipt,
    conflictMessage: 'product xHarness source candidate receipt conflicts',
  });
  await publishSourceCandidateRef({
    repositoryRoot,
    candidateRef,
    candidateCommitId,
  });
  return Object.freeze({
    receipt,
    created: publication.created,
  });
}

export async function recoverProductXHarnessSourceCandidateBuild(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly receiptDigest: Sha256Digest;
}): Promise<ProductXHarnessSourceCandidateBuildReceipt> {
  const repositoryRoot = readNonEmptyString(
    input.repositoryRoot,
    'repositoryRoot',
  );
  const stateRoot = readNonEmptyString(input.stateRoot, 'stateRoot');
  const receiptDigest = readDigest(input.receiptDigest, 'receiptDigest');
  const receipt = parseProductXHarnessSourceCandidateBuildReceipt(
    await readRequiredJson(
      sourceCandidateReceiptPath(stateRoot, receiptDigest),
      'product xHarness source candidate receipt is unavailable',
    ),
  );
  if (receipt.receiptDigest !== receiptDigest) {
    throw new Error(
      'product xHarness source candidate receipt path does not match its digest',
    );
  }
  await assertSourceCandidateBuildGitObjects(repositoryRoot, receipt);
  await publishSourceCandidateRef({
    repositoryRoot,
    candidateRef: receipt.candidateRef,
    candidateCommitId: receipt.candidateCommitId,
  });
  return receipt;
}

function assertSourceCandidateBuildOperation(
  value: unknown,
  index: number,
): ProductXHarnessSourceCandidateBuildOperation {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(
      `source candidate build operation ${index} must be a plain object`,
    );
  }
  const action = readSourceAction(
    Reflect.get(value, 'action'),
    `source candidate build operation ${index}.action`,
  );
  const expectedKeys =
    action === 'delete' ? ['action', 'path'] : ['action', 'path', 'mode'];
  const record = assertExactPlainRecord(
    value,
    expectedKeys,
    `source candidate build operation ${index}`,
  );
  const path = readRepositoryRelativePath(
    record.path,
    `source candidate build operation ${index}.path`,
  );
  if (action === 'delete') {
    return Object.freeze({ action, path });
  }
  if (record.mode !== '100644' && record.mode !== '100755') {
    throw new Error(
      `source candidate build operation ${index}.mode must be 100644 or 100755`,
    );
  }
  return Object.freeze({ action, path, mode: record.mode });
}

function assertBuildPlanMatchesExpectedChanges(
  expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[],
  operations: readonly ProductXHarnessSourceCandidateBuildOperation[],
): void {
  if (!Array.isArray(expectedFileChanges) || expectedFileChanges.length === 0) {
    throw new Error('expectedFileChanges must contain at least one change');
  }
  const seen = new Set<string>();
  const expected = expectedFileChanges.map((change, index) => {
    const record = assertExactPlainRecord(
      change,
      ['path', 'action'],
      `expectedFileChanges[${index}]`,
    );
    const path = readRepositoryRelativePath(
      record.path,
      `expectedFileChanges[${index}].path`,
    );
    assertUnique(seen, path, 'expected source path');
    return Object.freeze({
      path,
      action: readSourceAction(
        record.action,
        `expectedFileChanges[${index}].action`,
      ),
    });
  });
  expected.sort((left, right) => left.path.localeCompare(right.path));
  const actual = operations.map(({ path, action }) => ({ path, action }));
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error(
      'source candidate build plan does not match its admitted file changes',
    );
  }
}

async function resolveCandidateSourceRoot(value: unknown): Promise<string> {
  const candidate = readNonEmptyString(value, 'candidateSourceRoot');
  if (!isAbsolute(candidate)) {
    throw new Error('candidateSourceRoot must be absolute');
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      throw new Error('candidateSourceRoot is unavailable');
    }
    throw error;
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error('candidateSourceRoot must be a directory');
  }
  return resolved;
}

async function buildSourceCandidateTree(input: {
  readonly repositoryRoot: string;
  readonly candidateSourceRoot: string;
  readonly baselineCommitId: string;
  readonly operations: readonly ProductXHarnessSourceCandidateBuildOperation[];
}): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-candidate-index-'),
  );
  const indexPath = join(temporaryDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await runGit(input.repositoryRoot, ['read-tree', input.baselineCommitId], {
      env,
    });
    for (const operation of input.operations) {
      if (operation.action === 'delete') {
        await runGit(
          input.repositoryRoot,
          ['update-index', '--force-remove', '--', operation.path],
          { env },
        );
        continue;
      }
      const source = await readCandidateSourceFile(
        input.candidateSourceRoot,
        operation.path,
      );
      const objectId = readObjectId(
        decodeGitText(
          (
            await runGit(
              input.repositoryRoot,
              ['hash-object', '-w', '--stdin'],
              {
                input: source,
              },
            )
          ).stdout,
        ).trim(),
        `source candidate object for ${operation.path}`,
      );
      await runGit(
        input.repositoryRoot,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          operation.mode,
          objectId,
          operation.path,
        ],
        { env },
      );
    }
    return readObjectId(
      decodeGitText(
        (await runGit(input.repositoryRoot, ['write-tree'], { env })).stdout,
      ).trim(),
      'source candidate tree',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readCandidateSourceFile(
  candidateSourceRoot: string,
  repositoryPath: string,
): Promise<Buffer> {
  const targetPath = resolve(candidateSourceRoot, repositoryPath);
  if (!isPathInside(candidateSourceRoot, targetPath)) {
    throw new Error(
      `${repositoryPath} must be a regular file below candidateSourceRoot`,
    );
  }
  try {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(
        `${repositoryPath} must be a regular file below candidateSourceRoot`,
      );
    }
    const resolvedPath = await realpath(targetPath);
    if (!isPathInside(candidateSourceRoot, resolvedPath)) {
      throw new Error(
        `${repositoryPath} must be a regular file below candidateSourceRoot`,
      );
    }
    const handle = await open(resolvedPath, 'r');
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error(
          `${repositoryPath} must be a regular file below candidateSourceRoot`,
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ELOOP')) {
      throw new Error(
        `${repositoryPath} must be a regular file below candidateSourceRoot`,
      );
    }
    throw error;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function parseProductXHarnessSourceCandidateBuildReceipt(
  value: unknown,
): ProductXHarnessSourceCandidateBuildReceipt {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'receiptKind',
      'candidateId',
      'packetDigest',
      'planDigest',
      'repositoryObjectFormat',
      'baselineCommitId',
      'baselineTreeId',
      'candidateTreeId',
      'candidateCommitId',
      'candidateRef',
      'changes',
      'receiptDigest',
    ],
    'source candidate build receipt',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported source candidate build receipt schemaVersion');
  }
  if (record.receiptKind !== 'xharness_git_source_candidate_build') {
    throw new Error('unsupported source candidate build receipt kind');
  }
  const packetDigest = readDigest(record.packetDigest, 'packetDigest');
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_git_source_candidate_build' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest,
    planDigest: readDigest(record.planDigest, 'planDigest'),
    repositoryObjectFormat: readNonEmptyString(
      record.repositoryObjectFormat,
      'repositoryObjectFormat',
    ),
    baselineCommitId: readObjectId(record.baselineCommitId, 'baselineCommitId'),
    baselineTreeId: readObjectId(record.baselineTreeId, 'baselineTreeId'),
    candidateTreeId: readObjectId(record.candidateTreeId, 'candidateTreeId'),
    candidateCommitId: readObjectId(
      record.candidateCommitId,
      'candidateCommitId',
    ),
    candidateRef: readNonEmptyString(record.candidateRef, 'candidateRef'),
    changes: parseSourceChanges(record.changes),
  });
  if (body.candidateRef !== sourceCandidateRef(packetDigest)) {
    throw new Error(
      'source candidate build receipt ref does not match its packet',
    );
  }
  const receiptDigest = readDigest(record.receiptDigest, 'receiptDigest');
  if (`sha256:${sha256StableJson(body)}` !== receiptDigest) {
    throw new Error(
      'source candidate build receipt digest does not match its body',
    );
  }
  return Object.freeze({ ...body, receiptDigest });
}

async function assertSourceCandidateBuildGitObjects(
  repositoryRoot: string,
  receipt: ProductXHarnessSourceCandidateBuildReceipt,
): Promise<void> {
  const repositoryObjectFormat = readNonEmptyString(
    decodeGitText(
      (await runGit(repositoryRoot, ['rev-parse', '--show-object-format']))
        .stdout,
    ).trim(),
    'repository object format',
  );
  if (repositoryObjectFormat !== receipt.repositoryObjectFormat) {
    throw new Error(
      'source candidate build receipt belongs to another Git object format',
    );
  }
  const baselineCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    receipt.baselineCommitId,
  );
  const candidateCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    receipt.candidateCommitId,
  );
  if (
    baselineCommitId !== receipt.baselineCommitId ||
    candidateCommitId !== receipt.candidateCommitId ||
    (await readCommitTreeId(repositoryRoot, baselineCommitId)) !==
      receipt.baselineTreeId ||
    (await readCommitTreeId(repositoryRoot, candidateCommitId)) !==
      receipt.candidateTreeId
  ) {
    throw new Error('source candidate build Git objects changed');
  }
  const parentCommitId = readObjectId(
    decodeGitText(
      (
        await runGit(repositoryRoot, [
          'rev-parse',
          '--verify',
          `${candidateCommitId}^`,
        ])
      ).stdout,
    ).trim(),
    'source candidate parent commit',
  );
  if (parentCommitId !== baselineCommitId) {
    throw new Error('source candidate build commit has another parent');
  }
  const changes = await readSourceChanges(
    repositoryRoot,
    baselineCommitId,
    candidateCommitId,
  );
  if (stableStringify(changes) !== stableStringify(receipt.changes)) {
    throw new Error('source candidate build Git diff changed');
  }
}

async function publishSourceCandidateRef(input: {
  readonly repositoryRoot: string;
  readonly candidateRef: string;
  readonly candidateCommitId: string;
}): Promise<void> {
  await validateGitRef(input.repositoryRoot, input.candidateRef);
  const current = (
    await readGitRefs(input.repositoryRoot, [input.candidateRef])
  ).get(input.candidateRef);
  if (current === input.candidateCommitId) {
    return;
  }
  if (current !== undefined) {
    throw new Error(
      'source candidate packet ref already names another Git candidate',
    );
  }
  try {
    await runGit(input.repositoryRoot, ['update-ref', '--stdin'], {
      input: `create ${input.candidateRef} ${input.candidateCommitId}\n`,
    });
  } catch (error: unknown) {
    const reconciled = (
      await readGitRefs(input.repositoryRoot, [input.candidateRef])
    ).get(input.candidateRef);
    if (reconciled === input.candidateCommitId) {
      return;
    }
    throw error;
  }
}

export async function buildProductXHarnessSourcePortfolioProposal(input: {
  readonly repositoryRoot: string;
  readonly baselineCommitId: string;
  readonly portfolioDecisionDigest: Sha256Digest;
  readonly candidates: readonly ProductXHarnessSourceCandidateAuthority[];
}): Promise<ProductXHarnessSourcePortfolioProposal> {
  const repositoryRoot = readNonEmptyString(
    input.repositoryRoot,
    'repositoryRoot',
  );
  const baselineCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    readObjectId(input.baselineCommitId, 'baselineCommitId'),
  );
  const portfolioDecisionDigest = readDigest(
    input.portfolioDecisionDigest,
    'portfolioDecisionDigest',
  );
  if (input.candidates.length === 0) {
    throw new Error('source portfolio requires at least one candidate');
  }
  const repositoryObjectFormat = readNonEmptyString(
    decodeGitText(
      (await runGit(repositoryRoot, ['rev-parse', '--show-object-format']))
        .stdout,
    ).trim(),
    'repository object format',
  );
  const baselineTreeId = await readCommitTreeId(
    repositoryRoot,
    baselineCommitId,
  );
  const candidateIds = new Set<string>();
  const decisionDigests = new Set<string>();
  const packetDigests = new Set<string>();
  const changedPaths = new Set<string>();
  const candidates: ProductXHarnessSourceCandidate[] = [];

  for (const authority of input.candidates) {
    const candidateId = readCandidateId(authority.candidateId);
    assertUnique(candidateIds, candidateId, 'candidate id');
    const decisionDigest = readDigest(
      authority.decisionDigest,
      'decisionDigest',
    );
    assertUnique(decisionDigests, decisionDigest, 'decision digest');
    const packetDigest = readDigest(authority.packetDigest, 'packetDigest');
    assertUnique(packetDigests, packetDigest, 'packet digest');
    const qualificationReceiptDigest =
      authority.qualificationReceiptDigest === null
        ? null
        : readDigest(
            authority.qualificationReceiptDigest,
            'qualificationReceiptDigest',
          );
    const buckets = readCanonicalStrings(authority.buckets, 'buckets');
    const candidateCommitId = await resolveProductXHarnessGitCommit(
      repositoryRoot,
      readObjectId(authority.candidateCommitId, 'candidateCommitId'),
    );
    if (candidateCommitId === baselineCommitId) {
      throw new Error('source candidate commit must differ from its baseline');
    }
    const candidateTreeId = await readCommitTreeId(
      repositoryRoot,
      candidateCommitId,
    );
    const changes = await readSourceChanges(
      repositoryRoot,
      baselineCommitId,
      candidateCommitId,
    );
    assertExpectedChanges(authority.expectedFileChanges, changes);
    for (const change of changes) {
      assertUnique(
        changedPaths,
        change.path,
        'path across source portfolio candidates',
      );
    }
    const candidateBody = Object.freeze({
      candidateId,
      buckets,
      decisionDigest,
      packetDigest,
      qualificationReceiptDigest,
      baselineCommitId,
      baselineTreeId,
      candidateCommitId,
      candidateTreeId,
      changes,
    });
    candidates.push(
      Object.freeze({
        ...candidateBody,
        sourceCandidateDigest:
          `sha256:${sha256StableJson(candidateBody)}` as Sha256Digest,
      }),
    );
  }

  const composedTreeId = await composeSourcePortfolioTree(
    repositoryRoot,
    baselineCommitId,
    candidates,
  );
  const body = Object.freeze({
    schemaVersion: 1 as const,
    proposalKind: 'xharness_git_source_portfolio' as const,
    portfolioDecisionDigest,
    repositoryObjectFormat,
    baselineCommitId,
    baselineTreeId,
    candidates: Object.freeze(candidates),
    composedTreeId,
  });
  return Object.freeze({
    ...body,
    proposalDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
}

export function createProductXHarnessSourcePortfolioApproval(input: {
  readonly proposal: ProductXHarnessSourcePortfolioProposal;
  readonly decisionType: 'publish' | 'reject';
  readonly authorityIdentity: Sha256Digest;
}): ProductXHarnessSourcePortfolioApproval {
  const proposal = parseProductXHarnessSourcePortfolioProposal(input.proposal);
  if (input.decisionType !== 'publish' && input.decisionType !== 'reject') {
    throw new Error(
      'source portfolio approval decisionType must be publish or reject',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    approvalKind: 'xharness_git_source_portfolio' as const,
    proposalDigest: proposal.proposalDigest,
    decisionType: input.decisionType,
    authorityIdentity: readDigest(input.authorityIdentity, 'authorityIdentity'),
  });
  return Object.freeze({
    ...body,
    approvalDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
}

export function parseProductXHarnessSourcePortfolioProposal(
  value: unknown,
): ProductXHarnessSourcePortfolioProposal {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'proposalKind',
      'portfolioDecisionDigest',
      'repositoryObjectFormat',
      'baselineCommitId',
      'baselineTreeId',
      'candidates',
      'composedTreeId',
      'proposalDigest',
    ],
    'source portfolio proposal',
  );
  if (
    record.schemaVersion !== 1 ||
    record.proposalKind !== 'xharness_git_source_portfolio'
  ) {
    throw new Error('unsupported source portfolio proposal');
  }
  const candidates = parseSourceCandidates(record.candidates);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    proposalKind: 'xharness_git_source_portfolio' as const,
    portfolioDecisionDigest: readDigest(
      record.portfolioDecisionDigest,
      'portfolioDecisionDigest',
    ),
    repositoryObjectFormat: readNonEmptyString(
      record.repositoryObjectFormat,
      'repositoryObjectFormat',
    ),
    baselineCommitId: readObjectId(record.baselineCommitId, 'baselineCommitId'),
    baselineTreeId: readObjectId(record.baselineTreeId, 'baselineTreeId'),
    candidates,
    composedTreeId: readObjectId(record.composedTreeId, 'composedTreeId'),
  });
  for (const candidate of candidates) {
    if (
      candidate.baselineCommitId !== body.baselineCommitId ||
      candidate.baselineTreeId !== body.baselineTreeId
    ) {
      throw new Error(
        'source portfolio candidate does not share the proposal baseline',
      );
    }
  }
  const proposalDigest = readDigest(record.proposalDigest, 'proposalDigest');
  if (`sha256:${sha256StableJson(body)}` !== proposalDigest) {
    throw new Error('source portfolio proposal digest does not match its body');
  }
  return Object.freeze({ ...body, proposalDigest });
}

function parseProductXHarnessSourcePortfolioApproval(
  value: unknown,
): ProductXHarnessSourcePortfolioApproval {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'approvalKind',
      'proposalDigest',
      'decisionType',
      'authorityIdentity',
      'approvalDigest',
    ],
    'source portfolio approval',
  );
  if (
    record.schemaVersion !== 1 ||
    record.approvalKind !== 'xharness_git_source_portfolio'
  ) {
    throw new Error('unsupported source portfolio approval');
  }
  if (record.decisionType !== 'publish' && record.decisionType !== 'reject') {
    throw new Error(
      'source portfolio approval decisionType must be publish or reject',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    approvalKind: 'xharness_git_source_portfolio' as const,
    proposalDigest: readDigest(record.proposalDigest, 'proposalDigest'),
    decisionType: record.decisionType,
    authorityIdentity: readDigest(
      record.authorityIdentity,
      'authorityIdentity',
    ),
  });
  const approvalDigest = readDigest(record.approvalDigest, 'approvalDigest');
  if (`sha256:${sha256StableJson(body)}` !== approvalDigest) {
    throw new Error('source portfolio approval digest does not match its body');
  }
  return Object.freeze({ ...body, approvalDigest });
}

export async function recordProductXHarnessSourcePortfolioProposal(
  stateRoot: string,
  value: ProductXHarnessSourcePortfolioProposal,
): Promise<{
  readonly proposal: ProductXHarnessSourcePortfolioProposal;
  readonly created: boolean;
}> {
  const proposal = parseProductXHarnessSourcePortfolioProposal(value);
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: sourceProposalPath(stateRoot, proposal.proposalDigest),
    pendingDirectory: sourcePendingDirectory(stateRoot),
    value: proposal,
    conflictMessage: 'product xHarness source proposal conflicts',
  });
  return Object.freeze({ proposal, created: publication.created });
}

export async function recordProductXHarnessSourcePortfolioApproval(
  stateRoot: string,
  value: ProductXHarnessSourcePortfolioApproval,
): Promise<{
  readonly approval: ProductXHarnessSourcePortfolioApproval;
  readonly created: boolean;
}> {
  const approval = parseProductXHarnessSourcePortfolioApproval(value);
  const proposal = await readProductXHarnessSourcePortfolioProposal(
    stateRoot,
    approval.proposalDigest,
  );
  if (proposal.proposalDigest !== approval.proposalDigest) {
    throw new Error('source portfolio approval names another proposal');
  }
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: sourceApprovalPath(stateRoot, approval.approvalDigest),
    pendingDirectory: sourcePendingDirectory(stateRoot),
    value: approval,
    conflictMessage: 'product xHarness source approval conflicts',
  });
  return Object.freeze({ approval, created: publication.created });
}

export async function readProductXHarnessSourcePortfolioProposal(
  stateRoot: string,
  proposalDigest: string,
): Promise<ProductXHarnessSourcePortfolioProposal> {
  return parseProductXHarnessSourcePortfolioProposal(
    await readRequiredJson(
      sourceProposalPath(
        stateRoot,
        readDigest(proposalDigest, 'proposalDigest'),
      ),
      'product xHarness source proposal is unavailable',
    ),
  );
}

export async function readProductXHarnessSourcePortfolioApproval(
  stateRoot: string,
  approvalDigest: string,
): Promise<ProductXHarnessSourcePortfolioApproval> {
  return parseProductXHarnessSourcePortfolioApproval(
    await readRequiredJson(
      sourceApprovalPath(
        stateRoot,
        readDigest(approvalDigest, 'approvalDigest'),
      ),
      'product xHarness source approval is unavailable',
    ),
  );
}

export async function publishProductXHarnessSourcePortfolio(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly publicationRef: string;
  readonly proposal: ProductXHarnessSourcePortfolioProposal;
  readonly approval: ProductXHarnessSourcePortfolioApproval;
}): Promise<{
  readonly receipt: ProductXHarnessSourcePublicationReceipt;
  readonly created: boolean;
}> {
  const repositoryRoot = readNonEmptyString(
    input.repositoryRoot,
    'repositoryRoot',
  );
  const stateRoot = readNonEmptyString(input.stateRoot, 'stateRoot');
  const publicationRef = await validatePublicationRef(
    repositoryRoot,
    input.publicationRef,
  );
  const proposal = parseProductXHarnessSourcePortfolioProposal(input.proposal);
  const approval = parseProductXHarnessSourcePortfolioApproval(input.approval);
  if (approval.proposalDigest !== proposal.proposalDigest) {
    throw new Error('source portfolio approval names another proposal');
  }
  if (approval.decisionType !== 'publish') {
    throw new Error('source portfolio publication requires publish approval');
  }
  await assertProposalGitObjects(repositoryRoot, proposal);
  await recordProductXHarnessSourcePortfolioProposal(stateRoot, proposal);
  await recordProductXHarnessSourcePortfolioApproval(stateRoot, approval);

  const commitRecord = createPublicationCommitRecord(proposal, approval);
  const publicationCommitId = await createPublicationCommit(
    repositoryRoot,
    proposal,
    commitRecord,
  );
  await publishGitRefs({
    repositoryRoot,
    publicationRef,
    baselineCommitId: proposal.baselineCommitId,
    publicationCommitId,
    approvalDigest: approval.approvalDigest,
  });

  const archive = await publishSourceArchive(
    repositoryRoot,
    stateRoot,
    publicationCommitId,
  );
  const receiptBody = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_git_source_publication' as const,
    proposalDigest: proposal.proposalDigest,
    approvalDigest: approval.approvalDigest,
    portfolioDecisionDigest: proposal.portfolioDecisionDigest,
    baselineCommitId: proposal.baselineCommitId,
    composedTreeId: proposal.composedTreeId,
    publicationCommitId,
    publicationRef,
    candidateSourceDigests: Object.freeze(
      proposal.candidates.map((candidate) => candidate.sourceCandidateDigest),
    ),
    archiveFormat: 'tar' as const,
    archiveDigest: archive.digest,
    archiveBytes: archive.bytes,
  });
  const receipt = Object.freeze({
    ...receiptBody,
    publicationReceiptDigest:
      `sha256:${sha256StableJson(receiptBody)}` as Sha256Digest,
  });
  await publishProductXHarnessImmutableJson({
    targetPath: sourceReceiptPath(stateRoot, receipt.publicationReceiptDigest),
    pendingDirectory: sourcePendingDirectory(stateRoot),
    value: receipt,
    conflictMessage: 'product xHarness source publication receipt conflicts',
  });
  const claim = Object.freeze({
    approvalDigest: approval.approvalDigest,
    publicationReceiptDigest: receipt.publicationReceiptDigest,
  });
  const claimPublication = await publishProductXHarnessImmutableJson({
    targetPath: sourceClaimPath(stateRoot, approval.approvalDigest),
    pendingDirectory: sourcePendingDirectory(stateRoot),
    value: claim,
    conflictMessage:
      'product xHarness source approval already has another publication',
  });
  return Object.freeze({
    receipt,
    created: claimPublication.created,
  });
}

export async function recoverProductXHarnessSourcePortfolioPublication(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly publicationRef: string;
  readonly approvalDigest: string;
}): Promise<{
  readonly receipt: ProductXHarnessSourcePublicationReceipt;
  readonly created: boolean;
}> {
  const approval = await readProductXHarnessSourcePortfolioApproval(
    input.stateRoot,
    input.approvalDigest,
  );
  const proposal = await readProductXHarnessSourcePortfolioProposal(
    input.stateRoot,
    approval.proposalDigest,
  );
  return await publishProductXHarnessSourcePortfolio({
    repositoryRoot: input.repositoryRoot,
    stateRoot: input.stateRoot,
    publicationRef: input.publicationRef,
    proposal,
    approval,
  });
}

async function assertProposalGitObjects(
  repositoryRoot: string,
  proposal: ProductXHarnessSourcePortfolioProposal,
): Promise<void> {
  const baselineCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    proposal.baselineCommitId,
  );
  if (baselineCommitId !== proposal.baselineCommitId) {
    throw new Error('source proposal baseline commit is unavailable');
  }
  if (
    (await readCommitTreeId(repositoryRoot, baselineCommitId)) !==
    proposal.baselineTreeId
  ) {
    throw new Error('source proposal baseline tree changed');
  }
  for (const candidate of proposal.candidates) {
    const candidateCommitId = await resolveProductXHarnessGitCommit(
      repositoryRoot,
      candidate.candidateCommitId,
    );
    if (
      candidateCommitId !== candidate.candidateCommitId ||
      (await readCommitTreeId(repositoryRoot, candidateCommitId)) !==
        candidate.candidateTreeId
    ) {
      throw new Error('source proposal candidate Git object is unavailable');
    }
    const changes = await readSourceChanges(
      repositoryRoot,
      proposal.baselineCommitId,
      candidateCommitId,
    );
    if (stableStringify(changes) !== stableStringify(candidate.changes)) {
      throw new Error('source proposal candidate diff changed');
    }
  }
  const recomposedTreeId = await composeSourcePortfolioTree(
    repositoryRoot,
    proposal.baselineCommitId,
    proposal.candidates,
  );
  if (recomposedTreeId !== proposal.composedTreeId) {
    throw new Error('source proposal composed tree changed');
  }
}

function createPublicationCommitRecord(
  proposal: ProductXHarnessSourcePortfolioProposal,
  approval: ProductXHarnessSourcePortfolioApproval,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    recordKind: 'xharness_git_source_publication',
    proposalDigest: proposal.proposalDigest,
    approvalDigest: approval.approvalDigest,
    portfolioDecisionDigest: proposal.portfolioDecisionDigest,
    baselineCommitId: proposal.baselineCommitId,
    composedTreeId: proposal.composedTreeId,
    candidateSourceDigests: Object.freeze(
      proposal.candidates.map((candidate) => candidate.sourceCandidateDigest),
    ),
  });
}

async function createPublicationCommit(
  repositoryRoot: string,
  proposal: ProductXHarnessSourcePortfolioProposal,
  commitRecord: Readonly<Record<string, unknown>>,
): Promise<string> {
  return await createDeterministicSourceCommit({
    repositoryRoot,
    treeId: proposal.composedTreeId,
    baselineCommitId: proposal.baselineCommitId,
    commitRecord,
  });
}

async function createDeterministicSourceCommit(input: {
  readonly repositoryRoot: string;
  readonly treeId: string;
  readonly baselineCommitId: string;
  readonly commitRecord: Readonly<Record<string, unknown>>;
}): Promise<string> {
  const baselineDate = decodeGitText(
    (
      await runGit(input.repositoryRoot, [
        'show',
        '-s',
        '--format=%aI',
        input.baselineCommitId,
      ])
    ).stdout,
  ).trim();
  const result = await runGit(
    input.repositoryRoot,
    ['commit-tree', input.treeId, '-p', input.baselineCommitId],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Geulbat xHarness',
        GIT_AUTHOR_EMAIL: 'xharness@localhost',
        GIT_AUTHOR_DATE: baselineDate,
        GIT_COMMITTER_NAME: 'Geulbat xHarness',
        GIT_COMMITTER_EMAIL: 'xharness@localhost',
        GIT_COMMITTER_DATE: baselineDate,
      },
      input: `${stableStringify(input.commitRecord)}\n`,
    },
  );
  const publicationCommitId = readObjectId(
    decodeGitText(result.stdout).trim(),
    'publicationCommitId',
  );
  const publishedTreeId = await readCommitTreeId(
    input.repositoryRoot,
    publicationCommitId,
  );
  if (publishedTreeId !== input.treeId) {
    throw new Error('deterministic source commit contains another tree');
  }
  return publicationCommitId;
}

async function publishGitRefs(input: {
  readonly repositoryRoot: string;
  readonly publicationRef: string;
  readonly baselineCommitId: string;
  readonly publicationCommitId: string;
  readonly approvalDigest: Sha256Digest;
}): Promise<void> {
  const recordRef = `${SOURCE_PUBLICATION_RECORD_REF_PREFIX}${digestHex(
    input.approvalDigest,
  )}`;
  await validateGitRef(input.repositoryRoot, recordRef);
  const currentRefs = await readGitRefs(input.repositoryRoot, [
    input.publicationRef,
    recordRef,
  ]);
  const currentPublication = currentRefs.get(input.publicationRef) ?? null;
  const currentRecord = currentRefs.get(recordRef) ?? null;
  if (
    currentPublication === input.publicationCommitId &&
    currentRecord === input.publicationCommitId
  ) {
    return;
  }
  if (currentRecord !== null) {
    throw new Error(
      'source publication approval ref already names another commit',
    );
  }
  if (
    currentPublication !== null &&
    currentPublication !== input.baselineCommitId
  ) {
    throw new Error(
      'source publication ref no longer matches the approved baseline',
    );
  }
  const commands = [
    'start',
    `create ${recordRef} ${input.publicationCommitId}`,
    currentPublication === null
      ? `create ${input.publicationRef} ${input.publicationCommitId}`
      : `update ${input.publicationRef} ${input.publicationCommitId} ${input.baselineCommitId}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  try {
    await runGit(input.repositoryRoot, ['update-ref', '--stdin'], {
      input: commands,
    });
  } catch (error: unknown) {
    const reconciled = await readGitRefs(input.repositoryRoot, [
      input.publicationRef,
      recordRef,
    ]);
    if (
      reconciled.get(input.publicationRef) === input.publicationCommitId &&
      reconciled.get(recordRef) === input.publicationCommitId
    ) {
      return;
    }
    throw error;
  }
}

async function readGitRefs(
  repositoryRoot: string,
  references: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const result = await runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    '--sort=refname',
    '--',
    ...references,
  ]);
  const requested = new Set(references);
  const entries = new Map<string, string>();
  for (const line of decodeGitText(result.stdout).split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(' ');
    if (separator <= 0) {
      throw new Error('Git returned a malformed ref listing');
    }
    const reference = line.slice(0, separator);
    if (!requested.has(reference)) {
      continue;
    }
    entries.set(reference, readObjectId(line.slice(separator + 1), 'Git ref'));
  }
  return entries;
}

async function validatePublicationRef(
  repositoryRoot: string,
  value: string,
): Promise<string> {
  const reference = readNonEmptyString(value, 'publicationRef');
  if (!reference.startsWith(SOURCE_PUBLICATION_REF_PREFIX)) {
    throw new Error(
      `publicationRef must start with ${SOURCE_PUBLICATION_REF_PREFIX}`,
    );
  }
  await validateGitRef(repositoryRoot, reference);
  return reference;
}

async function validateGitRef(
  repositoryRoot: string,
  reference: string,
): Promise<void> {
  await runGit(repositoryRoot, ['check-ref-format', reference]);
}

async function publishSourceArchive(
  repositoryRoot: string,
  stateRoot: string,
  publicationCommitId: string,
): Promise<{ readonly digest: Sha256Digest; readonly bytes: number }> {
  const targetPath = sourceArchivePath(stateRoot, publicationCommitId);
  const pendingDirectory = sourcePendingDirectory(stateRoot);
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(pendingDirectory, { recursive: true });
  const temporaryPath = join(
    pendingDirectory,
    `${randomUUID()}.archive.pending`,
  );
  try {
    await runGit(repositoryRoot, [
      'archive',
      '--format=tar',
      `--output=${temporaryPath}`,
      publicationCommitId,
    ]);
    const temporaryHandle = await open(temporaryPath, 'r');
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    const generated = await digestFile(temporaryPath);
    try {
      await link(temporaryPath, targetPath);
    } catch (error: unknown) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
      const existing = await digestFile(targetPath);
      if (
        existing.digest !== generated.digest ||
        existing.bytes !== generated.bytes
      ) {
        throw new Error('product xHarness source archive conflicts');
      }
    }
    return generated;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isErrorCode(error, 'ENOENT')) {
        throw error;
      }
    });
  }
}

async function digestFile(
  filePath: string,
): Promise<{ readonly digest: Sha256Digest; readonly bytes: number }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(
    filePath,
  ) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  const metadata = await stat(filePath);
  return Object.freeze({
    digest: `sha256:${hash.digest('hex')}`,
    bytes: metadata.size,
  });
}

async function readCommitTreeId(
  repositoryRoot: string,
  commitId: string,
): Promise<string> {
  const result = await runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%T',
    commitId,
  ]);
  return readObjectId(decodeGitText(result.stdout).trim(), 'commit tree');
}

async function readSourceChanges(
  repositoryRoot: string,
  baselineCommitId: string,
  candidateCommitId: string,
): Promise<readonly ProductXHarnessSourceChange[]> {
  const result = await runGit(repositoryRoot, [
    'diff-tree',
    '--no-commit-id',
    '--raw',
    '-z',
    '--no-renames',
    baselineCommitId,
    candidateCommitId,
  ]);
  const fields = splitNullDelimited(result.stdout);
  if (fields.length === 0) {
    throw new Error('source candidate commit contains no changes');
  }
  if (fields.length % 2 !== 0) {
    throw new Error('Git returned a malformed raw source diff');
  }
  const changes: ProductXHarnessSourceChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = decodeGitText(fields[index] ?? Buffer.alloc(0));
    const rawPath = decodeGitText(fields[index + 1] ?? Buffer.alloc(0));
    const match = GIT_RAW_DIFF_HEADER_PATTERN.exec(header);
    if (match === null) {
      throw new Error('Git returned an unsupported raw source diff record');
    }
    const baselineMode = normalizeGitMode(match[1] ?? '', 'baselineMode');
    const candidateMode = normalizeGitMode(match[2] ?? '', 'candidateMode');
    const baselineObjectId = normalizeGitObjectId(
      match[3] ?? '',
      baselineMode,
      'baselineObjectId',
    );
    const candidateObjectId = normalizeGitObjectId(
      match[4] ?? '',
      candidateMode,
      'candidateObjectId',
    );
    const status = match[5];
    const action: SourceChangeAction =
      status === 'A' ? 'create' : status === 'D' ? 'delete' : 'modify';
    assertSourceChangeShape({
      action,
      baselineMode,
      candidateMode,
      baselineObjectId,
      candidateObjectId,
    });
    changes.push(
      Object.freeze({
        path: readRepositoryRelativePath(rawPath, 'source change path'),
        action,
        baselineObjectId,
        candidateObjectId,
        baselineMode,
        candidateMode,
      }),
    );
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(changes);
}

async function composeSourcePortfolioTree(
  repositoryRoot: string,
  baselineCommitId: string,
  candidates: readonly ProductXHarnessSourceCandidate[],
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-index-'),
  );
  const indexPath = join(temporaryDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await runGit(repositoryRoot, ['read-tree', baselineCommitId], { env });
    for (const candidate of candidates) {
      for (const change of candidate.changes) {
        if (change.action === 'delete') {
          await runGit(
            repositoryRoot,
            ['update-index', '--force-remove', '--', change.path],
            { env },
          );
          continue;
        }
        if (
          change.candidateMode === null ||
          change.candidateObjectId === null
        ) {
          throw new Error(
            'source create or modify change lacks candidate Git object',
          );
        }
        await runGit(
          repositoryRoot,
          [
            'update-index',
            '--add',
            '--cacheinfo',
            change.candidateMode,
            change.candidateObjectId,
            change.path,
          ],
          { env },
        );
      }
    }
    const result = await runGit(repositoryRoot, ['write-tree'], { env });
    return readObjectId(decodeGitText(result.stdout).trim(), 'composed tree');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertExpectedChanges(
  value: readonly ProductXHarnessExpectedSourceChange[],
  actual: readonly ProductXHarnessSourceChange[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('expectedFileChanges must contain at least one change');
  }
  const seen = new Set<string>();
  const expected = value.map((change, index) => {
    const record = assertExactPlainRecord(
      change,
      ['path', 'action'],
      `expectedFileChanges[${index}]`,
    );
    const path = readRepositoryRelativePath(
      record.path,
      `expectedFileChanges[${index}].path`,
    );
    assertUnique(seen, path, 'expected source path');
    const action = readSourceAction(
      record.action,
      `expectedFileChanges[${index}].action`,
    );
    return Object.freeze({ path, action });
  });
  expected.sort((left, right) => left.path.localeCompare(right.path));
  const actualSummary = actual.map(({ path, action }) => ({ path, action }));
  if (stableStringify(expected) !== stableStringify(actualSummary)) {
    throw new Error(
      'source candidate Git diff does not match its approved file_changes',
    );
  }
}

function parseSourceCandidates(
  value: unknown,
): readonly ProductXHarnessSourceCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('source portfolio candidates must be a non-empty array');
  }
  const candidateIds = new Set<string>();
  const decisionDigests = new Set<string>();
  const packetDigests = new Set<string>();
  const changedPaths = new Set<string>();
  const candidates = value.map((entry, index) => {
    const record = assertExactPlainRecord(
      entry,
      [
        'candidateId',
        'buckets',
        'decisionDigest',
        'packetDigest',
        'qualificationReceiptDigest',
        'baselineCommitId',
        'baselineTreeId',
        'candidateCommitId',
        'candidateTreeId',
        'changes',
        'sourceCandidateDigest',
      ],
      `source portfolio candidate ${index}`,
    );
    const candidateId = readCandidateId(record.candidateId);
    assertUnique(candidateIds, candidateId, 'candidate id');
    const decisionDigest = readDigest(record.decisionDigest, 'decisionDigest');
    assertUnique(decisionDigests, decisionDigest, 'decision digest');
    const packetDigest = readDigest(record.packetDigest, 'packetDigest');
    assertUnique(packetDigests, packetDigest, 'packet digest');
    const changes = parseSourceChanges(record.changes);
    for (const change of changes) {
      assertUnique(
        changedPaths,
        change.path,
        'path across source portfolio candidates',
      );
    }
    const body = Object.freeze({
      candidateId,
      buckets: readCanonicalStrings(record.buckets, 'buckets'),
      decisionDigest,
      packetDigest,
      qualificationReceiptDigest:
        record.qualificationReceiptDigest === null
          ? null
          : readDigest(
              record.qualificationReceiptDigest,
              'qualificationReceiptDigest',
            ),
      baselineCommitId: readObjectId(
        record.baselineCommitId,
        'baselineCommitId',
      ),
      baselineTreeId: readObjectId(record.baselineTreeId, 'baselineTreeId'),
      candidateCommitId: readObjectId(
        record.candidateCommitId,
        'candidateCommitId',
      ),
      candidateTreeId: readObjectId(record.candidateTreeId, 'candidateTreeId'),
      changes,
    });
    const sourceCandidateDigest = readDigest(
      record.sourceCandidateDigest,
      'sourceCandidateDigest',
    );
    if (`sha256:${sha256StableJson(body)}` !== sourceCandidateDigest) {
      throw new Error(
        'source portfolio candidate digest does not match its body',
      );
    }
    return Object.freeze({ ...body, sourceCandidateDigest });
  });
  return Object.freeze(candidates);
}

function parseSourceChanges(
  value: unknown,
): readonly ProductXHarnessSourceChange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('source candidate changes must be a non-empty array');
  }
  const paths = new Set<string>();
  const changes = value.map((entry, index) => {
    const record = assertExactPlainRecord(
      entry,
      [
        'path',
        'action',
        'baselineObjectId',
        'candidateObjectId',
        'baselineMode',
        'candidateMode',
      ],
      `source change ${index}`,
    );
    const path = readRepositoryRelativePath(
      record.path,
      `source change ${index}.path`,
    );
    assertUnique(paths, path, 'source change path');
    const action = readSourceAction(
      record.action,
      `source change ${index}.action`,
    );
    const baselineMode = readNullableMode(
      record.baselineMode,
      `source change ${index}.baselineMode`,
    );
    const candidateMode = readNullableMode(
      record.candidateMode,
      `source change ${index}.candidateMode`,
    );
    const baselineObjectId = readNullableObjectId(
      record.baselineObjectId,
      `source change ${index}.baselineObjectId`,
    );
    const candidateObjectId = readNullableObjectId(
      record.candidateObjectId,
      `source change ${index}.candidateObjectId`,
    );
    assertSourceChangeShape({
      action,
      baselineMode,
      candidateMode,
      baselineObjectId,
      candidateObjectId,
    });
    return Object.freeze({
      path,
      action,
      baselineObjectId,
      candidateObjectId,
      baselineMode,
      candidateMode,
    });
  });
  const sorted = [...changes].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (stableStringify(changes) !== stableStringify(sorted)) {
    throw new Error('source candidate changes are not canonical');
  }
  return Object.freeze(changes);
}

function assertSourceChangeShape(value: {
  readonly action: SourceChangeAction;
  readonly baselineMode: string | null;
  readonly candidateMode: string | null;
  readonly baselineObjectId: string | null;
  readonly candidateObjectId: string | null;
}): void {
  if (
    value.action === 'create' &&
    (value.baselineMode !== null ||
      value.baselineObjectId !== null ||
      value.candidateMode === null ||
      value.candidateObjectId === null)
  ) {
    throw new Error('source create change has inconsistent Git objects');
  }
  if (
    value.action === 'delete' &&
    (value.baselineMode === null ||
      value.baselineObjectId === null ||
      value.candidateMode !== null ||
      value.candidateObjectId !== null)
  ) {
    throw new Error('source delete change has inconsistent Git objects');
  }
  if (
    value.action === 'modify' &&
    (value.baselineMode === null ||
      value.baselineObjectId === null ||
      value.candidateMode === null ||
      value.candidateObjectId === null)
  ) {
    throw new Error('source modify change has inconsistent Git objects');
  }
}

function normalizeGitMode(value: string, label: string): string | null {
  if (value === ZERO_MODE) {
    return null;
  }
  if (!SUPPORTED_FILE_MODES.has(value)) {
    throw new Error(`${label} is an unsupported Git file mode`);
  }
  return value;
}

function normalizeGitObjectId(
  value: string,
  mode: string | null,
  label: string,
): string | null {
  if (mode === null) {
    if (!/^0+$/u.test(value)) {
      throw new Error(`${label} must be zero when the path is absent`);
    }
    return null;
  }
  return readObjectId(value, label);
}

function readNullableMode(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !SUPPORTED_FILE_MODES.has(value)) {
    throw new Error(`${label} is an unsupported Git file mode`);
  }
  return value;
}

function readNullableObjectId(value: unknown, label: string): string | null {
  return value === null ? null : readObjectId(value, label);
}

function readSourceAction(value: unknown, label: string): SourceChangeAction {
  if (value !== 'create' && value !== 'modify' && value !== 'delete') {
    throw new Error(`${label} must be create, modify, or delete`);
  }
  return value;
}

function readCanonicalStrings(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const seen = new Set<string>();
  const strings = value.map((entry, index) => {
    const item = readNonEmptyString(entry, `${label}[${index}]`);
    assertUnique(seen, item, `${label} entry`);
    return item;
  });
  return Object.freeze(strings);
}

function readCandidateId(value: unknown): string {
  const candidateId = readNonEmptyString(value, 'candidateId');
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error('candidateId is invalid');
  }
  return candidateId;
}

function assertUnique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) {
    throw new Error(`source portfolio contains duplicate ${label}: ${value}`);
  }
  seen.add(value);
}

function splitNullDelimited(value: Buffer): readonly Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) {
      continue;
    }
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) {
    throw new Error('Git returned an unterminated null-delimited result');
  }
  return fields;
}

function decodeGitText(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('Git returned non-UTF-8 source metadata');
  }
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const result = await runGitAllowFailure(repositoryRoot, args, options);
  if (result.exitCode !== 0) {
    throw gitFailure(result);
  }
  return result;
}

async function runGitAllowFailure(
  repositoryRoot: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryRoot, ...args], {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (signal !== null) {
        reject(new Error(`git terminated by signal ${signal}`));
        return;
      }
      resolve(
        Object.freeze({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      );
    });
    child.stdin.end(options.input);
  });
}

function gitFailure(result: GitResult): Error {
  const detail = decodeGitText(result.stderr).trim();
  return new Error(
    detail.length === 0
      ? `git exited with code ${result.exitCode}`
      : `git exited with code ${result.exitCode}: ${detail}`,
  );
}

function sourceRoot(stateRoot: string): string {
  return join(stateRoot, ...SOURCE_PUBLICATION_DIRECTORY);
}

function sourcePendingDirectory(stateRoot: string): string {
  return join(sourceRoot(stateRoot), 'pending');
}

function sourceCandidateReceiptPath(
  stateRoot: string,
  receiptDigest: Sha256Digest,
): string {
  return join(
    sourceRoot(stateRoot),
    'candidate-builds',
    `${digestHex(receiptDigest)}.json`,
  );
}

function sourceCandidateRef(packetDigest: Sha256Digest): string {
  return `${SOURCE_CANDIDATE_REF_PREFIX}${digestHex(packetDigest)}`;
}

function sourceProposalPath(
  stateRoot: string,
  proposalDigest: Sha256Digest,
): string {
  return join(
    sourceRoot(stateRoot),
    'proposals',
    `${digestHex(proposalDigest)}.json`,
  );
}

function sourceApprovalPath(
  stateRoot: string,
  approvalDigest: Sha256Digest,
): string {
  return join(
    sourceRoot(stateRoot),
    'approvals',
    `${digestHex(approvalDigest)}.json`,
  );
}

function sourceArchivePath(
  stateRoot: string,
  publicationCommitId: string,
): string {
  return join(
    sourceRoot(stateRoot),
    'archives',
    `${readObjectId(publicationCommitId, 'publicationCommitId')}.tar`,
  );
}

function sourceReceiptPath(
  stateRoot: string,
  receiptDigest: Sha256Digest,
): string {
  return join(
    sourceRoot(stateRoot),
    'receipts',
    `${digestHex(receiptDigest)}.json`,
  );
}

function sourceClaimPath(
  stateRoot: string,
  approvalDigest: Sha256Digest,
): string {
  return join(
    sourceRoot(stateRoot),
    'by-approval',
    `${digestHex(approvalDigest)}.json`,
  );
}

function digestHex(digest: Sha256Digest): string {
  return digest.slice('sha256:'.length);
}
