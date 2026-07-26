import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

import { publishProductXHarnessImmutableJson } from '@geulbat/product/immutable-publication';
import {
  buildProductXHarnessSourceCandidate,
  parseProductXHarnessSourceCandidateBuildPlan,
  recoverProductXHarnessSourceCandidateBuild,
  resolveProductXHarnessGitCommit,
  type ProductXHarnessExpectedSourceChange,
  type ProductXHarnessSourceCandidateBuildPlan,
  type ProductXHarnessSourceCandidateBuildReceipt,
} from './product-xharness-source-publication.js';
import {
  assertExactPlainRecord,
  isPlainRecord,
  readDigest,
  readNonEmptyString,
  readObjectId,
  readRepositoryRelativePath,
  readRequiredJson,
  type Sha256Digest,
} from '@geulbat/product/cli-support';

type SourceChangeAction = 'create' | 'modify' | 'delete';

interface ProductXHarnessSourceCandidateGenerationBrief {
  readonly schemaVersion: 1;
  readonly briefKind: 'xharness_source_candidate_generation';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly instructions: string;
  readonly contextPaths: readonly string[];
  readonly briefDigest: Sha256Digest;
}

interface ProductXHarnessSourceCandidateModelRequestSource {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly content: string;
}

interface ProductXHarnessSourceCandidateModelRequest {
  readonly schemaVersion: 1;
  readonly requestKind: 'xharness_source_candidate_generation';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly baselineCommitId: string;
  readonly briefDigest: Sha256Digest;
  readonly instructions: string;
  readonly changeManifest: unknown;
  readonly sources: readonly ProductXHarnessSourceCandidateModelRequestSource[];
  readonly requestDigest: Sha256Digest;
}

type ProductXHarnessSourceCandidateModelOperation =
  | {
      readonly action: 'create' | 'modify';
      readonly path: string;
      readonly mode: '100644' | '100755';
      readonly content: string;
    }
  | {
      readonly action: 'delete';
      readonly path: string;
    };

interface ProductXHarnessSourceCandidateModelProposal {
  readonly schemaVersion: 1;
  readonly proposalKind: 'xharness_model_source_candidate';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly modelConfigId: Sha256Digest;
  readonly modelRequestDigest: Sha256Digest;
  readonly operations: readonly ProductXHarnessSourceCandidateModelOperation[];
  readonly planDigest: Sha256Digest;
  readonly proposalDigest: Sha256Digest;
}

interface ProductXHarnessSourceCandidateVerificationCommand {
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface ProductXHarnessSourceCandidateVerificationPlan {
  readonly schemaVersion: 1;
  readonly planKind: 'xharness_source_candidate_verification';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly commands: readonly ProductXHarnessSourceCandidateVerificationCommand[];
  readonly planDigest: Sha256Digest;
}

interface ProductXHarnessSourceCandidateSandboxIdentity {
  readonly executionSurface: 'ptc_local_docker';
  readonly policyDigest: Sha256Digest;
  readonly imageRef: string;
  readonly imagePolicyId: string;
  readonly networkMode: 'none';
  readonly packageCachePolicyId: 'caller_read_only_npm_cache_v1';
  readonly packageLockDigest: Sha256Digest;
  readonly cpus: string;
  readonly memory: string;
  readonly pidsLimit: string;
}

interface ProductXHarnessSourceCandidateCommandExecution {
  readonly status:
    | 'exit'
    | 'timeout'
    | 'cancelled'
    | 'crash'
    | 'cleanup_failed';
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

interface ProductXHarnessSourceCandidateVerificationOutcome {
  readonly commandId: string;
  readonly status: ProductXHarnessSourceCandidateCommandExecution['status'];
  readonly exitCode: number | null;
  readonly stdoutDigest: Sha256Digest;
  readonly stdoutBytes: number;
  readonly stdoutBase64: string;
  readonly stderrDigest: Sha256Digest;
  readonly stderrBytes: number;
  readonly stderrBase64: string;
  readonly passed: boolean;
}

interface ProductXHarnessSourceCandidateQualificationReceipt {
  readonly schemaVersion: 1;
  readonly receiptKind: 'xharness_source_candidate_qualification';
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly sourceOriginKind: 'explicit_plan' | 'model_proposal';
  readonly sourceOriginDigest: Sha256Digest;
  readonly buildReceiptDigest: Sha256Digest;
  readonly buildPlanDigest: Sha256Digest;
  readonly baselineCommitId: string;
  readonly candidateCommitId: string;
  readonly verificationPlanDigest: Sha256Digest;
  readonly sandbox: ProductXHarnessSourceCandidateSandboxIdentity;
  readonly commandOutcomes: readonly ProductXHarnessSourceCandidateVerificationOutcome[];
  readonly qualified: boolean;
  readonly qualificationReceiptDigest: Sha256Digest;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GIT_TREE_ENTRY_PATTERN =
  /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/u;
const SOURCE_GENERATION_DIRECTORY = [
  '.geulbat',
  'xharness',
  'source-generation',
] as const;

export function parseProductXHarnessSourceCandidateGenerationBrief(
  value: unknown,
): ProductXHarnessSourceCandidateGenerationBrief {
  if (!isPlainRecord(value)) {
    throw new Error('source candidate generation brief must be a plain object');
  }
  const hasDigest = Object.hasOwn(value, 'briefDigest');
  const record = assertExactPlainRecord(
    value,
    hasDigest
      ? [
          'schemaVersion',
          'briefKind',
          'candidateId',
          'packetDigest',
          'instructions',
          'contextPaths',
          'briefDigest',
        ]
      : [
          'schemaVersion',
          'briefKind',
          'candidateId',
          'packetDigest',
          'instructions',
          'contextPaths',
        ],
    'source candidate generation brief',
  );
  if (
    record.schemaVersion !== 1 ||
    record.briefKind !== 'xharness_source_candidate_generation'
  ) {
    throw new Error('unsupported source candidate generation brief');
  }
  const contextPaths = readCanonicalStrings(
    record.contextPaths,
    'contextPaths',
    readRepositoryRelativePath,
  );
  const body = Object.freeze({
    schemaVersion: 1 as const,
    briefKind: 'xharness_source_candidate_generation' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    instructions: readNonEmptyString(record.instructions, 'instructions'),
    contextPaths,
  });
  const brief = Object.freeze({
    ...body,
    briefDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
  if (
    hasDigest &&
    readDigest(record.briefDigest, 'briefDigest') !== brief.briefDigest
  ) {
    throw new Error('source candidate generation brief digest does not match');
  }
  return brief;
}

export async function createProductXHarnessSourceCandidateModelRequest(input: {
  readonly repositoryRoot: string;
  readonly baselineRevision: string;
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly changeManifest: unknown;
  readonly expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[];
  readonly brief: ProductXHarnessSourceCandidateGenerationBrief;
}): Promise<ProductXHarnessSourceCandidateModelRequest> {
  const repositoryRoot = readNonEmptyString(
    input.repositoryRoot,
    'repositoryRoot',
  );
  const candidateId = readCandidateId(input.candidateId);
  const packetDigest = readDigest(input.packetDigest, 'packetDigest');
  const brief = parseProductXHarnessSourceCandidateGenerationBrief(input.brief);
  if (
    brief.candidateId !== candidateId ||
    brief.packetDigest !== packetDigest
  ) {
    throw new Error(
      'source candidate generation brief does not identify its packet',
    );
  }
  const baselineCommitId = await resolveProductXHarnessGitCommit(
    repositoryRoot,
    readNonEmptyString(input.baselineRevision, 'baselineRevision'),
  );
  const sourcePaths = new Set<string>(brief.contextPaths);
  for (const change of normalizeExpectedFileChanges(
    input.expectedFileChanges,
  )) {
    if (change.action !== 'create') {
      sourcePaths.add(change.path);
    }
  }
  const sources: ProductXHarnessSourceCandidateModelRequestSource[] = [];
  for (const sourcePath of [...sourcePaths].sort()) {
    sources.push(
      await readGitTextSource(repositoryRoot, baselineCommitId, sourcePath),
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    requestKind: 'xharness_source_candidate_generation' as const,
    candidateId,
    packetDigest,
    baselineCommitId,
    briefDigest: brief.briefDigest,
    instructions: brief.instructions,
    changeManifest: normalizeJsonValue(
      input.changeManifest,
      'source candidate change manifest',
    ),
    sources: Object.freeze(sources),
  });
  return Object.freeze({
    ...body,
    requestDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
}

function parseProductXHarnessSourceCandidateModelRequest(
  value: unknown,
): ProductXHarnessSourceCandidateModelRequest {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'requestKind',
      'candidateId',
      'packetDigest',
      'baselineCommitId',
      'briefDigest',
      'instructions',
      'changeManifest',
      'sources',
      'requestDigest',
    ],
    'source candidate model request',
  );
  if (
    record.schemaVersion !== 1 ||
    record.requestKind !== 'xharness_source_candidate_generation'
  ) {
    throw new Error('unsupported source candidate model request');
  }
  if (!Array.isArray(record.sources)) {
    throw new Error('source candidate model request sources must be an array');
  }
  const sourcePaths = new Set<string>();
  const sources = record.sources.map((source, index) => {
    const parsed = parseModelRequestSource(source, index);
    assertUnique(sourcePaths, parsed.path, 'source candidate request path');
    return parsed;
  });
  const sortedPaths = [...sourcePaths].sort();
  if (
    stableStringify(sources.map(({ path }) => path)) !==
    stableStringify(sortedPaths)
  ) {
    throw new Error(
      'source candidate model request sources must use canonical path order',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    requestKind: 'xharness_source_candidate_generation' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    baselineCommitId: readObjectId(record.baselineCommitId, 'baselineCommitId'),
    briefDigest: readDigest(record.briefDigest, 'briefDigest'),
    instructions: readNonEmptyString(record.instructions, 'instructions'),
    changeManifest: normalizeJsonValue(
      record.changeManifest,
      'source candidate change manifest',
    ),
    sources: Object.freeze(sources),
  });
  const requestDigest = readDigest(record.requestDigest, 'requestDigest');
  if (`sha256:${sha256StableJson(body)}` !== requestDigest) {
    throw new Error('source candidate model request digest does not match');
  }
  return Object.freeze({ ...body, requestDigest });
}

export function createProductXHarnessSourceCandidateModelProposal(input: {
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly modelConfigId: Sha256Digest;
  readonly modelRequestDigest: Sha256Digest;
  readonly expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[];
  readonly submission: unknown;
}): ProductXHarnessSourceCandidateModelProposal {
  const candidateId = readCandidateId(input.candidateId);
  const packetDigest = readDigest(input.packetDigest, 'packetDigest');
  const submission = assertExactPlainRecord(
    input.submission,
    ['schemaVersion', 'candidateId', 'packetDigest', 'operations'],
    'source candidate model submission',
  );
  if (submission.schemaVersion !== 1) {
    throw new Error(
      'unsupported source candidate model submission schemaVersion',
    );
  }
  if (
    readCandidateId(submission.candidateId) !== candidateId ||
    readDigest(submission.packetDigest, 'submission.packetDigest') !==
      packetDigest
  ) {
    throw new Error(
      'source candidate model submission does not identify its packet',
    );
  }
  if (
    !Array.isArray(submission.operations) ||
    submission.operations.length === 0
  ) {
    throw new Error(
      'source candidate model submission requires at least one operation',
    );
  }
  const paths = new Set<string>();
  const operations = submission.operations.map((operation, index) => {
    const parsed = parseModelOperation(operation, index);
    assertUnique(paths, parsed.path, 'source candidate model operation path');
    return parsed;
  });
  operations.sort((left, right) => left.path.localeCompare(right.path));
  assertModelOperationsMatchExpectedChanges(
    input.expectedFileChanges,
    operations,
  );
  const plan = parseProductXHarnessSourceCandidateBuildPlan({
    schemaVersion: 1,
    planKind: 'xharness_git_source_candidate',
    candidateId,
    packetDigest,
    operations: operations.map((operation) =>
      operation.action === 'delete'
        ? {
            action: operation.action,
            path: operation.path,
          }
        : {
            action: operation.action,
            path: operation.path,
            mode: operation.mode,
          },
    ),
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    proposalKind: 'xharness_model_source_candidate' as const,
    candidateId,
    packetDigest,
    modelConfigId: readDigest(input.modelConfigId, 'modelConfigId'),
    modelRequestDigest: readDigest(
      input.modelRequestDigest,
      'modelRequestDigest',
    ),
    operations: Object.freeze(operations),
    planDigest: plan.planDigest,
  });
  return Object.freeze({
    ...body,
    proposalDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
}

export async function buildProductXHarnessModelSourceCandidate(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly baselineCommitId: string;
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly expectedFileChanges: readonly ProductXHarnessExpectedSourceChange[];
  readonly modelConfigId: Sha256Digest;
  readonly modelRequest: ProductXHarnessSourceCandidateModelRequest;
  readonly submission: unknown;
}): Promise<{
  readonly requestCreated: boolean;
  readonly proposal: ProductXHarnessSourceCandidateModelProposal;
  readonly proposalCreated: boolean;
  readonly build: {
    readonly receipt: ProductXHarnessSourceCandidateBuildReceipt;
    readonly created: boolean;
  };
}> {
  const modelRequest = parseProductXHarnessSourceCandidateModelRequest(
    input.modelRequest,
  );
  if (
    modelRequest.candidateId !== input.candidateId ||
    modelRequest.packetDigest !== input.packetDigest ||
    modelRequest.baselineCommitId !== input.baselineCommitId
  ) {
    throw new Error(
      'source candidate model request does not identify its candidate build',
    );
  }
  const requestPublication =
    await recordProductXHarnessSourceCandidateModelRequest(
      input.stateRoot,
      modelRequest,
    );
  const proposal = createProductXHarnessSourceCandidateModelProposal({
    ...input,
    modelRequestDigest: modelRequest.requestDigest,
  });
  const proposalPublication =
    await recordProductXHarnessSourceCandidateModelProposal(
      input.stateRoot,
      proposal,
    );
  const temporarySourceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-model-source-'),
  );
  try {
    for (const operation of proposal.operations) {
      if (operation.action === 'delete') {
        continue;
      }
      const targetPath = join(
        temporarySourceRoot,
        ...operation.path.split('/'),
      );
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, operation.content, 'utf8');
    }
    const planInput = {
      schemaVersion: 1,
      planKind: 'xharness_git_source_candidate',
      candidateId: proposal.candidateId,
      packetDigest: proposal.packetDigest,
      operations: proposal.operations.map((operation) =>
        operation.action === 'delete'
          ? { action: operation.action, path: operation.path }
          : {
              action: operation.action,
              path: operation.path,
              mode: operation.mode,
            },
      ),
    } as const;
    const plan: ProductXHarnessSourceCandidateBuildPlan =
      parseProductXHarnessSourceCandidateBuildPlan(planInput);
    if (plan.planDigest !== proposal.planDigest) {
      throw new Error('source candidate model proposal plan changed');
    }
    const build = await buildProductXHarnessSourceCandidate({
      repositoryRoot: input.repositoryRoot,
      stateRoot: input.stateRoot,
      candidateSourceRoot: temporarySourceRoot,
      baselineCommitId: input.baselineCommitId,
      candidateId: proposal.candidateId,
      packetDigest: proposal.packetDigest,
      expectedFileChanges: input.expectedFileChanges,
      plan: planInput,
    });
    return Object.freeze({
      requestCreated: requestPublication.created,
      proposal,
      proposalCreated: proposalPublication.created,
      build,
    });
  } finally {
    await rm(temporarySourceRoot, { recursive: true, force: true });
  }
}

export function parseProductXHarnessSourceCandidateVerificationPlan(
  value: unknown,
): ProductXHarnessSourceCandidateVerificationPlan {
  if (!isPlainRecord(value)) {
    throw new Error(
      'source candidate verification plan must be a plain object',
    );
  }
  const hasDigest = Object.hasOwn(value, 'planDigest');
  const record = assertExactPlainRecord(
    value,
    hasDigest
      ? [
          'schemaVersion',
          'planKind',
          'candidateId',
          'packetDigest',
          'commands',
          'planDigest',
        ]
      : [
          'schemaVersion',
          'planKind',
          'candidateId',
          'packetDigest',
          'commands',
        ],
    'source candidate verification plan',
  );
  if (
    record.schemaVersion !== 1 ||
    record.planKind !== 'xharness_source_candidate_verification'
  ) {
    throw new Error('unsupported source candidate verification plan');
  }
  if (!Array.isArray(record.commands) || record.commands.length === 0) {
    throw new Error(
      'source candidate verification plan requires at least one command',
    );
  }
  const commandIds = new Set<string>();
  const commands = record.commands.map((command, index) => {
    const parsed = parseVerificationCommand(command, index);
    assertUnique(commandIds, parsed.commandId, 'verification command id');
    return parsed;
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    planKind: 'xharness_source_candidate_verification' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    commands: Object.freeze(commands),
  });
  const plan = Object.freeze({
    ...body,
    planDigest: `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
  if (
    hasDigest &&
    readDigest(record.planDigest, 'planDigest') !== plan.planDigest
  ) {
    throw new Error('source candidate verification plan digest does not match');
  }
  return plan;
}

export async function verifyProductXHarnessSourceCandidate(input: {
  readonly stateRoot: string;
  readonly buildReceipt: ProductXHarnessSourceCandidateBuildReceipt;
  readonly sourceOrigin:
    | {
        readonly kind: 'explicit_plan';
        readonly digest: Sha256Digest;
      }
    | {
        readonly kind: 'model_proposal';
        readonly proposal: ProductXHarnessSourceCandidateModelProposal;
      };
  readonly plan: ProductXHarnessSourceCandidateVerificationPlan;
  readonly sandbox: ProductXHarnessSourceCandidateSandboxIdentity;
  readonly runCommand: (
    command: ProductXHarnessSourceCandidateVerificationCommand,
  ) => Promise<ProductXHarnessSourceCandidateCommandExecution>;
}): Promise<{
  readonly receipt: ProductXHarnessSourceCandidateQualificationReceipt;
  readonly created: boolean;
}> {
  const stateRoot = readNonEmptyString(input.stateRoot, 'stateRoot');
  const buildReceipt = input.buildReceipt;
  const plan = parseProductXHarnessSourceCandidateVerificationPlan(input.plan);
  if (
    plan.candidateId !== buildReceipt.candidateId ||
    plan.packetDigest !== buildReceipt.packetDigest
  ) {
    throw new Error(
      'source candidate verification plan does not identify its build',
    );
  }
  const sourceOrigin = normalizeSourceOrigin(input.sourceOrigin, buildReceipt);
  const sandbox = parseSandboxIdentity(input.sandbox);
  await recordProductXHarnessSourceCandidateVerificationPlan(stateRoot, plan);
  const outcomes: ProductXHarnessSourceCandidateVerificationOutcome[] = [];
  for (const command of plan.commands) {
    let execution: ProductXHarnessSourceCandidateCommandExecution;
    try {
      execution = parseCommandExecution(await input.runCommand(command));
    } catch (error: unknown) {
      execution = Object.freeze({
        status: 'crash' as const,
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(
          error instanceof Error
            ? error.message
            : 'source candidate verification runner crashed',
          'utf8',
        ),
      });
    }
    const outcome = createVerificationOutcome(command.commandId, execution);
    outcomes.push(outcome);
    if (!outcome.passed) {
      break;
    }
  }
  const qualified =
    outcomes.length === plan.commands.length &&
    outcomes.every((outcome) => outcome.passed);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_source_candidate_qualification' as const,
    candidateId: buildReceipt.candidateId,
    packetDigest: buildReceipt.packetDigest,
    sourceOriginKind: sourceOrigin.kind,
    sourceOriginDigest: sourceOrigin.digest,
    buildReceiptDigest: buildReceipt.receiptDigest,
    buildPlanDigest: buildReceipt.planDigest,
    baselineCommitId: buildReceipt.baselineCommitId,
    candidateCommitId: buildReceipt.candidateCommitId,
    verificationPlanDigest: plan.planDigest,
    sandbox,
    commandOutcomes: Object.freeze(outcomes),
    qualified,
  });
  const receipt = Object.freeze({
    ...body,
    qualificationReceiptDigest:
      `sha256:${sha256StableJson(body)}` as Sha256Digest,
  });
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: qualificationReceiptPath(
      stateRoot,
      receipt.qualificationReceiptDigest,
    ),
    pendingDirectory: sourceGenerationPendingDirectory(stateRoot),
    value: receipt,
    conflictMessage: 'product xHarness source qualification receipt conflicts',
  });
  return Object.freeze({ receipt, created: publication.created });
}

export async function recoverProductXHarnessSourceCandidateQualification(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly qualificationReceiptDigest: Sha256Digest;
}): Promise<ProductXHarnessSourceCandidateQualificationReceipt> {
  const stateRoot = readNonEmptyString(input.stateRoot, 'stateRoot');
  const qualificationReceiptDigest = readDigest(
    input.qualificationReceiptDigest,
    'qualificationReceiptDigest',
  );
  const receipt = parseQualificationReceipt(
    await readRequiredJson(
      qualificationReceiptPath(stateRoot, qualificationReceiptDigest),
      'product xHarness source qualification receipt is unavailable',
    ),
  );
  if (receipt.qualificationReceiptDigest !== qualificationReceiptDigest) {
    throw new Error(
      'source qualification receipt path does not match its digest',
    );
  }
  const buildReceipt = await recoverProductXHarnessSourceCandidateBuild({
    repositoryRoot: input.repositoryRoot,
    stateRoot,
    receiptDigest: receipt.buildReceiptDigest,
  });
  if (
    buildReceipt.candidateId !== receipt.candidateId ||
    buildReceipt.packetDigest !== receipt.packetDigest ||
    buildReceipt.planDigest !== receipt.buildPlanDigest ||
    buildReceipt.baselineCommitId !== receipt.baselineCommitId ||
    buildReceipt.candidateCommitId !== receipt.candidateCommitId
  ) {
    throw new Error(
      'source qualification receipt does not reproduce its candidate build',
    );
  }
  const plan = parseProductXHarnessSourceCandidateVerificationPlan(
    await readRequiredJson(
      verificationPlanPath(stateRoot, receipt.verificationPlanDigest),
      'product xHarness source verification plan is unavailable',
    ),
  );
  if (
    plan.planDigest !== receipt.verificationPlanDigest ||
    plan.candidateId !== receipt.candidateId ||
    plan.packetDigest !== receipt.packetDigest
  ) {
    throw new Error(
      'source qualification receipt does not reproduce its verification plan',
    );
  }
  assertVerificationOutcomesReproducePlan(receipt, plan);
  if (receipt.sourceOriginKind === 'explicit_plan') {
    if (receipt.sourceOriginDigest !== buildReceipt.planDigest) {
      throw new Error(
        'source qualification explicit plan does not reproduce its build',
      );
    }
  } else {
    const proposal = await readProductXHarnessSourceCandidateModelProposal(
      stateRoot,
      receipt.sourceOriginDigest,
    );
    if (
      proposal.candidateId !== receipt.candidateId ||
      proposal.packetDigest !== receipt.packetDigest ||
      proposal.planDigest !== buildReceipt.planDigest
    ) {
      throw new Error(
        'source qualification model proposal does not reproduce its build',
      );
    }
    const request = await readProductXHarnessSourceCandidateModelRequest(
      stateRoot,
      proposal.modelRequestDigest,
    );
    if (
      request.candidateId !== receipt.candidateId ||
      request.packetDigest !== receipt.packetDigest ||
      request.baselineCommitId !== receipt.baselineCommitId
    ) {
      throw new Error(
        'source qualification model request does not reproduce its build',
      );
    }
  }
  return receipt;
}

export async function recordProductXHarnessSourceCandidateModelRequest(
  stateRoot: string,
  request: ProductXHarnessSourceCandidateModelRequest,
): Promise<{ readonly created: boolean }> {
  const parsed = parseProductXHarnessSourceCandidateModelRequest(request);
  return await publishProductXHarnessImmutableJson({
    targetPath: modelRequestPath(stateRoot, parsed.requestDigest),
    pendingDirectory: sourceGenerationPendingDirectory(stateRoot),
    value: parsed,
    conflictMessage: 'product xHarness source model request conflicts',
  });
}

async function readProductXHarnessSourceCandidateModelRequest(
  stateRoot: string,
  requestDigest: Sha256Digest,
): Promise<ProductXHarnessSourceCandidateModelRequest> {
  const digest = readDigest(requestDigest, 'requestDigest');
  const request = parseProductXHarnessSourceCandidateModelRequest(
    await readRequiredJson(
      modelRequestPath(stateRoot, digest),
      'product xHarness source model request is unavailable',
    ),
  );
  if (request.requestDigest !== digest) {
    throw new Error('source model request path does not match its digest');
  }
  return request;
}

async function recordProductXHarnessSourceCandidateModelProposal(
  stateRoot: string,
  proposal: ProductXHarnessSourceCandidateModelProposal,
): Promise<{ readonly created: boolean }> {
  const parsed = parseModelProposal(proposal);
  return await publishProductXHarnessImmutableJson({
    targetPath: modelProposalPath(stateRoot, parsed.proposalDigest),
    pendingDirectory: sourceGenerationPendingDirectory(stateRoot),
    value: parsed,
    conflictMessage: 'product xHarness source model proposal conflicts',
  });
}

async function readProductXHarnessSourceCandidateModelProposal(
  stateRoot: string,
  proposalDigest: Sha256Digest,
): Promise<ProductXHarnessSourceCandidateModelProposal> {
  const digest = readDigest(proposalDigest, 'proposalDigest');
  const proposal = parseModelProposal(
    await readRequiredJson(
      modelProposalPath(stateRoot, digest),
      'product xHarness source model proposal is unavailable',
    ),
  );
  if (proposal.proposalDigest !== digest) {
    throw new Error('source model proposal path does not match its digest');
  }
  return proposal;
}

function parseModelProposal(
  value: unknown,
): ProductXHarnessSourceCandidateModelProposal {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'proposalKind',
      'candidateId',
      'packetDigest',
      'modelConfigId',
      'modelRequestDigest',
      'operations',
      'planDigest',
      'proposalDigest',
    ],
    'source candidate model proposal',
  );
  if (
    record.schemaVersion !== 1 ||
    record.proposalKind !== 'xharness_model_source_candidate'
  ) {
    throw new Error('unsupported source candidate model proposal');
  }
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error(
      'source candidate model proposal requires at least one operation',
    );
  }
  const paths = new Set<string>();
  const operations = record.operations.map((operation, index) => {
    const parsed = parseModelOperation(operation, index);
    assertUnique(paths, parsed.path, 'source candidate model operation path');
    return parsed;
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    proposalKind: 'xharness_model_source_candidate' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    modelConfigId: readDigest(record.modelConfigId, 'modelConfigId'),
    modelRequestDigest: readDigest(
      record.modelRequestDigest,
      'modelRequestDigest',
    ),
    operations: Object.freeze(operations),
    planDigest: readDigest(record.planDigest, 'planDigest'),
  });
  const proposalDigest = readDigest(record.proposalDigest, 'proposalDigest');
  if (`sha256:${sha256StableJson(body)}` !== proposalDigest) {
    throw new Error('source candidate model proposal digest does not match');
  }
  return Object.freeze({ ...body, proposalDigest });
}

function parseQualificationReceipt(
  value: unknown,
): ProductXHarnessSourceCandidateQualificationReceipt {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'receiptKind',
      'candidateId',
      'packetDigest',
      'sourceOriginKind',
      'sourceOriginDigest',
      'buildReceiptDigest',
      'buildPlanDigest',
      'baselineCommitId',
      'candidateCommitId',
      'verificationPlanDigest',
      'sandbox',
      'commandOutcomes',
      'qualified',
      'qualificationReceiptDigest',
    ],
    'source candidate qualification receipt',
  );
  if (
    record.schemaVersion !== 1 ||
    record.receiptKind !== 'xharness_source_candidate_qualification'
  ) {
    throw new Error('unsupported source candidate qualification receipt');
  }
  if (
    record.sourceOriginKind !== 'explicit_plan' &&
    record.sourceOriginKind !== 'model_proposal'
  ) {
    throw new Error(
      'source candidate qualification receipt has unsupported origin',
    );
  }
  if (!Array.isArray(record.commandOutcomes)) {
    throw new Error(
      'source candidate qualification receipt outcomes must be an array',
    );
  }
  const commandIds = new Set<string>();
  const commandOutcomes = record.commandOutcomes.map((outcome, index) => {
    const parsed = parseVerificationOutcome(outcome, index);
    assertUnique(
      commandIds,
      parsed.commandId,
      'verification outcome command id',
    );
    return parsed;
  });
  if (typeof record.qualified !== 'boolean') {
    throw new Error(
      'source candidate qualification receipt qualified must be boolean',
    );
  }
  const qualified =
    commandOutcomes.length > 0 &&
    commandOutcomes.every((outcome) => outcome.passed);
  if (qualified !== record.qualified) {
    throw new Error(
      'source candidate qualification receipt qualified result is inconsistent',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_source_candidate_qualification' as const,
    candidateId: readCandidateId(record.candidateId),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    sourceOriginKind: record.sourceOriginKind,
    sourceOriginDigest: readDigest(
      record.sourceOriginDigest,
      'sourceOriginDigest',
    ),
    buildReceiptDigest: readDigest(
      record.buildReceiptDigest,
      'buildReceiptDigest',
    ),
    buildPlanDigest: readDigest(record.buildPlanDigest, 'buildPlanDigest'),
    baselineCommitId: readObjectId(record.baselineCommitId, 'baselineCommitId'),
    candidateCommitId: readObjectId(
      record.candidateCommitId,
      'candidateCommitId',
    ),
    verificationPlanDigest: readDigest(
      record.verificationPlanDigest,
      'verificationPlanDigest',
    ),
    sandbox: parseSandboxIdentity(record.sandbox),
    commandOutcomes: Object.freeze(commandOutcomes),
    qualified: record.qualified,
  });
  const qualificationReceiptDigest = readDigest(
    record.qualificationReceiptDigest,
    'qualificationReceiptDigest',
  );
  if (`sha256:${sha256StableJson(body)}` !== qualificationReceiptDigest) {
    throw new Error(
      'source candidate qualification receipt digest does not match',
    );
  }
  return Object.freeze({ ...body, qualificationReceiptDigest });
}

function parseModelRequestSource(
  value: unknown,
  index: number,
): ProductXHarnessSourceCandidateModelRequestSource {
  const record = assertExactPlainRecord(
    value,
    ['path', 'mode', 'content'],
    `source candidate model request source ${index}`,
  );
  if (record.mode !== '100644' && record.mode !== '100755') {
    throw new Error(
      `source candidate model request source ${index}.mode must be 100644 or 100755`,
    );
  }
  return Object.freeze({
    path: readRepositoryRelativePath(
      record.path,
      `source candidate model request source ${index}.path`,
    ),
    mode: record.mode,
    content: readString(
      record.content,
      `source candidate model request source ${index}.content`,
    ),
  });
}

function parseModelOperation(
  value: unknown,
  index: number,
): ProductXHarnessSourceCandidateModelOperation {
  if (!isPlainRecord(value)) {
    throw new Error(
      `source candidate model operation ${index} must be a plain object`,
    );
  }
  const action = readSourceChangeAction(
    value.action,
    `source candidate model operation ${index}.action`,
  );
  const path = readRepositoryRelativePath(
    value.path,
    `source candidate model operation ${index}.path`,
  );
  if (action === 'delete') {
    assertExactKeys(
      value,
      ['action', 'path'],
      `source candidate model operation ${index}`,
    );
    return Object.freeze({ action, path });
  }
  assertExactKeys(
    value,
    ['action', 'path', 'mode', 'content'],
    `source candidate model operation ${index}`,
  );
  if (value.mode !== '100644' && value.mode !== '100755') {
    throw new Error(
      `source candidate model operation ${index}.mode must be 100644 or 100755`,
    );
  }
  if (typeof value.content !== 'string') {
    throw new Error(
      `source candidate model operation ${index}.content must be a string`,
    );
  }
  return Object.freeze({
    action,
    path,
    mode: value.mode,
    content: value.content,
  });
}

function parseVerificationCommand(
  value: unknown,
  index: number,
): ProductXHarnessSourceCandidateVerificationCommand {
  const record = assertExactPlainRecord(
    value,
    ['commandId', 'argv', 'timeoutMs'],
    `verification command ${index}`,
  );
  const commandId = readNonEmptyString(
    record.commandId,
    `verification command ${index}.commandId`,
  );
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw new Error(`verification command ${index}.commandId is not canonical`);
  }
  if (!Array.isArray(record.argv) || record.argv.length === 0) {
    throw new Error(`verification command ${index}.argv must not be empty`);
  }
  const argv = record.argv.map((entry, argumentIndex) =>
    readNonEmptyString(
      entry,
      `verification command ${index}.argv[${argumentIndex}]`,
    ),
  );
  if (
    !Number.isSafeInteger(record.timeoutMs) ||
    (record.timeoutMs as number) <= 0
  ) {
    throw new Error(
      `verification command ${index}.timeoutMs must be a positive safe integer`,
    );
  }
  return Object.freeze({
    commandId,
    argv: Object.freeze(argv),
    timeoutMs: record.timeoutMs as number,
  });
}

function parseSandboxIdentity(
  value: unknown,
): ProductXHarnessSourceCandidateSandboxIdentity {
  const record = assertExactPlainRecord(
    value,
    [
      'executionSurface',
      'policyDigest',
      'imageRef',
      'imagePolicyId',
      'networkMode',
      'packageCachePolicyId',
      'packageLockDigest',
      'cpus',
      'memory',
      'pidsLimit',
    ],
    'source candidate sandbox identity',
  );
  if (
    record.executionSurface !== 'ptc_local_docker' ||
    record.networkMode !== 'none'
  ) {
    throw new Error(
      'source candidate sandbox must be local Docker without network',
    );
  }
  if (record.packageCachePolicyId !== 'caller_read_only_npm_cache_v1') {
    throw new Error(
      'source candidate sandbox package cache policy is unsupported',
    );
  }
  return Object.freeze({
    executionSurface: record.executionSurface,
    policyDigest: readDigest(record.policyDigest, 'sandbox.policyDigest'),
    imageRef: readNonEmptyString(record.imageRef, 'sandbox.imageRef'),
    imagePolicyId: readNonEmptyString(
      record.imagePolicyId,
      'sandbox.imagePolicyId',
    ),
    networkMode: record.networkMode,
    packageCachePolicyId: record.packageCachePolicyId,
    packageLockDigest: readDigest(
      record.packageLockDigest,
      'sandbox.packageLockDigest',
    ),
    cpus: readNonEmptyString(record.cpus, 'sandbox.cpus'),
    memory: readNonEmptyString(record.memory, 'sandbox.memory'),
    pidsLimit: readNonEmptyString(record.pidsLimit, 'sandbox.pidsLimit'),
  });
}

function parseCommandExecution(
  value: unknown,
): ProductXHarnessSourceCandidateCommandExecution {
  const record = assertExactPlainRecord(
    value,
    ['status', 'exitCode', 'stdout', 'stderr'],
    'source candidate verification execution',
  );
  const statuses = new Set([
    'exit',
    'timeout',
    'cancelled',
    'crash',
    'cleanup_failed',
  ]);
  if (typeof record.status !== 'string' || !statuses.has(record.status)) {
    throw new Error(
      'source candidate verification execution status is invalid',
    );
  }
  if (
    record.exitCode !== null &&
    (!Number.isSafeInteger(record.exitCode) || (record.exitCode as number) < 0)
  ) {
    throw new Error(
      'source candidate verification execution exitCode is invalid',
    );
  }
  if (
    record.status === 'exit'
      ? record.exitCode === null
      : record.exitCode !== null
  ) {
    throw new Error(
      'source candidate verification execution exitCode is inconsistent',
    );
  }
  return Object.freeze({
    status:
      record.status as ProductXHarnessSourceCandidateCommandExecution['status'],
    exitCode: record.exitCode as number | null,
    stdout: readExecutionBytes(
      record.stdout,
      'source candidate verification execution stdout',
    ),
    stderr: readExecutionBytes(
      record.stderr,
      'source candidate verification execution stderr',
    ),
  });
}

function createVerificationOutcome(
  commandId: string,
  execution: ProductXHarnessSourceCandidateCommandExecution,
): ProductXHarnessSourceCandidateVerificationOutcome {
  const stdout = Buffer.from(execution.stdout);
  const stderr = Buffer.from(execution.stderr);
  return Object.freeze({
    commandId,
    status: execution.status,
    exitCode: execution.exitCode,
    stdoutDigest: digestBytes(stdout),
    stdoutBytes: stdout.byteLength,
    stdoutBase64: stdout.toString('base64'),
    stderrDigest: digestBytes(stderr),
    stderrBytes: stderr.byteLength,
    stderrBase64: stderr.toString('base64'),
    passed: execution.status === 'exit' && execution.exitCode === 0,
  });
}

function assertVerificationOutcomesReproducePlan(
  receipt: ProductXHarnessSourceCandidateQualificationReceipt,
  plan: ProductXHarnessSourceCandidateVerificationPlan,
): void {
  const outcomes = receipt.commandOutcomes;
  if (outcomes.length === 0 || outcomes.length > plan.commands.length) {
    throw new Error(
      'source qualification receipt does not reproduce its verification command count',
    );
  }
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.commandId !== plan.commands[index]?.commandId) {
      throw new Error(
        'source qualification receipt does not reproduce its verification command order',
      );
    }
    if (index < outcomes.length - 1 && !outcome.passed) {
      throw new Error(
        'source qualification receipt continued after a failed verification command',
      );
    }
  }
  const expectedQualified =
    outcomes.length === plan.commands.length &&
    outcomes.every((outcome) => outcome.passed);
  if (
    receipt.qualified !== expectedQualified ||
    (!receipt.qualified && outcomes.at(-1)?.passed !== false)
  ) {
    throw new Error(
      'source qualification receipt does not reproduce verification settlement',
    );
  }
}

function parseVerificationOutcome(
  value: unknown,
  index: number,
): ProductXHarnessSourceCandidateVerificationOutcome {
  const record = assertExactPlainRecord(
    value,
    [
      'commandId',
      'status',
      'exitCode',
      'stdoutDigest',
      'stdoutBytes',
      'stdoutBase64',
      'stderrDigest',
      'stderrBytes',
      'stderrBase64',
      'passed',
    ],
    `verification outcome ${index}`,
  );
  const execution = parseCommandExecution({
    status: record.status,
    exitCode: record.exitCode,
    stdout: decodeBase64(record.stdoutBase64, `outcome ${index} stdout`),
    stderr: decodeBase64(record.stderrBase64, `outcome ${index} stderr`),
  });
  if (
    !Number.isSafeInteger(record.stdoutBytes) ||
    (record.stdoutBytes as number) < 0 ||
    !Number.isSafeInteger(record.stderrBytes) ||
    (record.stderrBytes as number) < 0
  ) {
    throw new Error(`verification outcome ${index} byte count is invalid`);
  }
  const outcome = createVerificationOutcome(
    readNonEmptyString(record.commandId, `outcome ${index}.commandId`),
    execution,
  );
  if (
    outcome.stdoutDigest !== readDigest(record.stdoutDigest, 'stdoutDigest') ||
    outcome.stdoutBytes !== record.stdoutBytes ||
    outcome.stdoutBase64 !== record.stdoutBase64 ||
    outcome.stderrDigest !== readDigest(record.stderrDigest, 'stderrDigest') ||
    outcome.stderrBytes !== record.stderrBytes ||
    outcome.stderrBase64 !== record.stderrBase64 ||
    outcome.passed !== record.passed
  ) {
    throw new Error(`verification outcome ${index} content is inconsistent`);
  }
  return outcome;
}

function normalizeSourceOrigin(
  value:
    | {
        readonly kind: 'explicit_plan';
        readonly digest: Sha256Digest;
      }
    | {
        readonly kind: 'model_proposal';
        readonly proposal: ProductXHarnessSourceCandidateModelProposal;
      },
  buildReceipt: ProductXHarnessSourceCandidateBuildReceipt,
): {
  readonly kind: 'explicit_plan' | 'model_proposal';
  readonly digest: Sha256Digest;
} {
  if (value.kind === 'explicit_plan') {
    const digest = readDigest(value.digest, 'sourceOrigin.digest');
    if (digest !== buildReceipt.planDigest) {
      throw new Error(
        'source qualification explicit plan does not match its build',
      );
    }
    return Object.freeze({ kind: value.kind, digest });
  }
  const proposal = parseModelProposal(value.proposal);
  if (
    proposal.candidateId !== buildReceipt.candidateId ||
    proposal.packetDigest !== buildReceipt.packetDigest ||
    proposal.planDigest !== buildReceipt.planDigest
  ) {
    throw new Error(
      'source qualification model proposal does not match its build',
    );
  }
  return Object.freeze({
    kind: value.kind,
    digest: proposal.proposalDigest,
  });
}

function assertModelOperationsMatchExpectedChanges(
  expected: readonly ProductXHarnessExpectedSourceChange[],
  operations: readonly ProductXHarnessSourceCandidateModelOperation[],
): void {
  const expectedRows = normalizeExpectedFileChanges(expected);
  const actualRows = operations.map(({ path, action }) => ({ path, action }));
  if (stableStringify(expectedRows) !== stableStringify(actualRows)) {
    throw new Error(
      'source candidate model operations do not match admitted file changes',
    );
  }
}

function normalizeExpectedFileChanges(
  value: readonly ProductXHarnessExpectedSourceChange[],
): readonly ProductXHarnessExpectedSourceChange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('expected source changes must not be empty');
  }
  const paths = new Set<string>();
  const normalized = value.map((change, index) => {
    if (!isPlainRecord(change)) {
      throw new Error(`expected source change ${index} must be a plain object`);
    }
    assertExactKeys(
      change,
      ['path', 'action'],
      `expected source change ${index}`,
    );
    const path = readRepositoryRelativePath(
      change.path,
      `expected source change ${index}.path`,
    );
    assertUnique(paths, path, 'expected source change path');
    return Object.freeze({
      path,
      action: readSourceChangeAction(
        change.action,
        `expected source change ${index}.action`,
      ),
    });
  });
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(normalized);
}

async function readGitTextSource(
  repositoryRoot: string,
  commitId: string,
  sourcePath: string,
): Promise<ProductXHarnessSourceCandidateModelRequestSource> {
  const path = readRepositoryRelativePath(sourcePath, 'source context path');
  const tree = await runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commitId,
    '--',
    path,
  ]);
  const raw = tree.stdout.subarray(
    0,
    tree.stdout.at(-1) === 0 ? tree.stdout.length - 1 : tree.stdout.length,
  );
  const entry = decodeGitText(raw);
  const match = GIT_TREE_ENTRY_PATTERN.exec(entry);
  if (
    match === null ||
    match[2] !== 'blob' ||
    match[4] !== path ||
    (match[1] !== '100644' && match[1] !== '100755')
  ) {
    throw new Error(
      `${path} must be a regular UTF-8 file in the baseline commit`,
    );
  }
  const content = decodeGitText(
    (
      await runGit(repositoryRoot, [
        'cat-file',
        'blob',
        readObjectId(match[3], 'source context object id'),
      ])
    ).stdout,
  );
  return Object.freeze({
    path,
    mode: match[1],
    content,
  });
}

async function recordProductXHarnessSourceCandidateVerificationPlan(
  stateRoot: string,
  plan: ProductXHarnessSourceCandidateVerificationPlan,
): Promise<{ readonly created: boolean }> {
  const parsed = parseProductXHarnessSourceCandidateVerificationPlan(plan);
  return await publishProductXHarnessImmutableJson({
    targetPath: verificationPlanPath(stateRoot, parsed.planDigest),
    pendingDirectory: sourceGenerationPendingDirectory(stateRoot),
    value: parsed,
    conflictMessage: 'product xHarness source verification plan conflicts',
  });
}

function sourceGenerationRoot(stateRoot: string): string {
  return join(
    readNonEmptyString(stateRoot, 'stateRoot'),
    ...SOURCE_GENERATION_DIRECTORY,
  );
}

function sourceGenerationPendingDirectory(stateRoot: string): string {
  return join(sourceGenerationRoot(stateRoot), 'pending');
}

function modelRequestPath(
  stateRoot: string,
  requestDigest: Sha256Digest,
): string {
  return join(
    sourceGenerationRoot(stateRoot),
    'model-requests',
    `${readDigest(requestDigest, 'requestDigest').slice('sha256:'.length)}.json`,
  );
}

function modelProposalPath(
  stateRoot: string,
  proposalDigest: Sha256Digest,
): string {
  return join(
    sourceGenerationRoot(stateRoot),
    'model-proposals',
    `${readDigest(proposalDigest, 'proposalDigest').slice('sha256:'.length)}.json`,
  );
}

function verificationPlanPath(
  stateRoot: string,
  planDigest: Sha256Digest,
): string {
  return join(
    sourceGenerationRoot(stateRoot),
    'verification-plans',
    `${readDigest(planDigest, 'verificationPlanDigest').slice('sha256:'.length)}.json`,
  );
}

function qualificationReceiptPath(
  stateRoot: string,
  receiptDigest: Sha256Digest,
): string {
  return join(
    sourceGenerationRoot(stateRoot),
    'qualification-receipts',
    `${readDigest(receiptDigest, 'qualificationReceiptDigest').slice('sha256:'.length)}.json`,
  );
}

function readCandidateId(value: unknown): string {
  const candidate = readNonEmptyString(value, 'candidateId');
  if (!CANDIDATE_ID_PATTERN.test(candidate)) {
    throw new Error('candidateId is not canonical');
  }
  return candidate;
}

function readSourceChangeAction(
  value: unknown,
  label: string,
): SourceChangeAction {
  if (value !== 'create' && value !== 'modify' && value !== 'delete') {
    throw new Error(`${label} must be create, modify, or delete`);
  }
  return value;
}

function readCanonicalStrings<T extends string>(
  value: unknown,
  label: string,
  parse: (entry: unknown, label: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  const entries = value.map((entry, index) => {
    const parsed = parse(entry, `${label}[${index}]`);
    assertUnique(seen, parsed, label);
    return parsed;
  });
  entries.sort();
  return Object.freeze(entries);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function normalizeJsonValue(value: unknown, label: string): unknown {
  try {
    const encoded = stableStringify(value);
    if (typeof encoded !== 'string') {
      throw new Error();
    }
    return JSON.parse(encoded);
  } catch {
    throw new Error(`${label} must be canonical JSON data`);
  }
}

function assertUnique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) {
    throw new Error(`${label} must be unique: ${value}`);
  }
  seen.add(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function digestBytes(value: Buffer): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readExecutionBytes(value: unknown, label: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be bytes`);
  }
  return Buffer.from(value);
}

function decodeBase64(value: unknown, label: string): Buffer {
  const encoded = readString(value, label);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

function decodeGitText(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('source candidate evidence must be UTF-8');
  }
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<GitResult> {
  const result = await new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryRoot, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
  });
  if (result.exitCode !== 0) {
    const detail = decodeGitText(result.stderr).trim();
    throw new Error(detail.length === 0 ? 'git command failed' : detail);
  }
  return result;
}
