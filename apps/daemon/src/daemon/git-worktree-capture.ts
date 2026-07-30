import { createHash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises';

import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  decodeGitAscii,
  decodeGitSingleLine,
  GIT_INSPECTION_GLOBAL_ARGUMENTS,
  gitInspectionFailure,
  gitModeClass,
  gitPathKey,
  isValidGitRelativePath,
  parseGitRelativePathSegments,
  readNodeErrorCode,
  readGitBlobObject,
  runGitInspectionCommand,
  splitGitNulRecords,
  type GitBlobReadResult,
  type GitInspectionCommandContext,
  type GitInspectionReadFailure,
  type GitObjectFormat,
  type GitObjectIndexSnapshot,
} from './git-inspection-command.js';

const PROC_SELF_FD_ROOT = '/proc/self/fd';
const WORKTREE_CAPTURE_READ_CHUNK_BYTES = 64 * 1024;

type GitIndexSnapshotEntry = GitObjectIndexSnapshot['indexEntries'][number];

export type GitComparisonContentKind =
  | 'text'
  | 'binary'
  | 'symlink'
  | 'submodule'
  | 'special'
  | 'unknown';

export interface GitWorktreeComparisonEntry {
  path: Buffer;
  mode: string;
  objectId: string | null;
  contentKind: GitComparisonContentKind;
  exactRenameIdentityVerified: boolean;
}

export interface GitWorktreeContentSnapshot {
  path: Buffer;
  canonicalContent: Buffer | null;
  projectionBlockReason: 'unsupported_content_transformation' | null;
}

export function hashGitBlobContent(
  content: Uint8Array,
  objectFormat: GitObjectFormat,
): string {
  const bytes = Buffer.from(content);
  return createHash(objectFormat)
    .update(`blob ${String(bytes.length)}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

export type GitWorktreeComparisonCaptureResult =
  | {
      ok: true;
      entries: readonly GitWorktreeComparisonEntry[];
      contents: readonly GitWorktreeContentSnapshot[];
    }
  | GitInspectionReadFailure;

interface GitWorktreeInventory {
  raw: Buffer;
  paths: readonly Buffer[];
}

interface GitCanonicalizationConfig {
  autoCrlf: 'false' | 'true' | 'input';
  fileMode: boolean;
}

interface GitCanonicalizationPolicyRead {
  raw: Buffer;
  policies: ReadonlyMap<string, GitWorktreeCanonicalizationPolicy>;
}

interface GitObservedWorktreeEntry {
  entry: GitWorktreeComparisonEntry;
  evidence: GitWorktreeFileCaptureEvidence;
  canonicalContent: Buffer | null;
  projectionBlockReason: 'unsupported_content_transformation' | null;
}

type GitObservedWorktreeEntryCaptureResult =
  | {
      ok: true;
      status: 'captured';
      observed: GitObservedWorktreeEntry | null;
    }
  | {
      ok: true;
      status: 'needs_policy';
    }
  | GitInspectionReadFailure;

export async function captureGitWorktreeComparisonEntries(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  snapshot: GitObjectIndexSnapshot;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  maxFileBytes: number;
  signal?: AbortSignal;
}): Promise<GitWorktreeComparisonCaptureResult> {
  if (!Number.isSafeInteger(args.maxFileBytes) || args.maxFileBytes < 0) {
    throw new RangeError(
      'Git worktree comparison maxFileBytes must be non-negative',
    );
  }
  const context: GitInspectionCommandContext = {
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    pageLimitBytes: args.pageLimitBytes,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  const [inventoryBefore, configBefore] = await Promise.all([
    readGitWorktreeInventory(context, args.snapshot.repositoryRoot),
    readGitCanonicalizationConfig(context, args.snapshot.repositoryRoot),
  ]);
  if (!inventoryBefore.ok) {
    return inventoryBefore;
  }
  if (!configBefore.ok) {
    return configBefore;
  }

  const indexByPath = new Map(
    args.snapshot.indexEntries
      .filter((entry) => entry.stage === 0)
      .map((entry) => [gitPathKey(entry.path), entry]),
  );
  const blobReads = new Map<string, Promise<GitBlobReadResult>>();
  const observedEntries: GitObservedWorktreeEntry[] = [];
  const policyPaths: Buffer[] = [];
  for (const path of inventoryBefore.inventory.paths) {
    const key = gitPathKey(path);
    const probed = await captureGitObservedWorktreeEntry({
      repositoryRoot: args.snapshot.repositoryRoot,
      relativePath: path,
      objectFormat: args.snapshot.objectFormat,
      indexEntry: indexByPath.get(key),
      indexTimestampNs: args.snapshot.indexTimestampNs,
      fileMode: configBefore.config.fileMode,
      policy: undefined,
      maxBytes: args.maxFileBytes,
    });
    if (!probed.ok) {
      return probed;
    }
    if (probed.status === 'needs_policy') {
      policyPaths.push(path);
    } else if (probed.observed !== null) {
      observedEntries.push(probed.observed);
    }
  }

  const policiesBefore = await readGitWorktreeCanonicalizationPolicies(
    context,
    args.snapshot.repositoryRoot,
    policyPaths,
    configBefore.config,
  );
  if (!policiesBefore.ok) {
    return policiesBefore;
  }
  for (const path of policyPaths) {
    const key = gitPathKey(path);
    const basePolicy = policiesBefore.value.policies.get(key);
    if (basePolicy === undefined) {
      return gitInspectionFailure(
        'invalid_output',
        'Git omitted a worktree canonicalization policy.',
      );
    }
    const indexEntry = indexByPath.get(key);
    let indexHasCrLf = false;
    if (
      basePolicy.text === 'auto' &&
      indexEntry !== undefined &&
      gitModeClass(indexEntry.mode) === 'regular'
    ) {
      let read = blobReads.get(indexEntry.objectId);
      if (read === undefined) {
        read = readGitBlobObject({
          hostCommands: args.hostCommands,
          stateRoot: args.stateRoot,
          repositoryRoot: args.snapshot.repositoryRoot,
          objectId: indexEntry.objectId,
          pageLimitBytes: args.pageLimitBytes,
          maxOutputBytesPerStream: args.maxOutputBytesPerStream,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });
        blobReads.set(indexEntry.objectId, read);
      }
      const blob = await read;
      if (!blob.ok) {
        return blob;
      }
      const statistics = gatherGitTextStatistics(blob.content);
      indexHasCrLf = !isGitBinaryContent(statistics) && statistics.crLf > 0;
    }

    const captured = await captureGitObservedWorktreeEntry({
      repositoryRoot: args.snapshot.repositoryRoot,
      relativePath: path,
      objectFormat: args.snapshot.objectFormat,
      indexEntry,
      indexTimestampNs: args.snapshot.indexTimestampNs,
      fileMode: configBefore.config.fileMode,
      policy: { ...basePolicy, indexHasCrLf },
      maxBytes: args.maxFileBytes,
    });
    if (!captured.ok) {
      return captured;
    }
    if (captured.status === 'captured' && captured.observed !== null) {
      observedEntries.push(captured.observed);
    }
  }
  const capturedPathKeys = new Set(
    observedEntries.map((observed) => gitPathKey(observed.entry.path)),
  );
  const deletedIndexIdentities = new Set(
    args.snapshot.indexEntries
      .filter(
        (entry) =>
          entry.stage === 0 &&
          !capturedPathKeys.has(gitPathKey(entry.path)) &&
          gitModeClass(entry.mode) !== 'unknown',
      )
      .map((entry) => `${gitModeClass(entry.mode)}:${entry.objectId}`),
  );
  for (const observed of observedEntries) {
    const { entry, canonicalContent } = observed;
    if (
      canonicalContent === null ||
      entry.objectId === null ||
      indexByPath.has(gitPathKey(entry.path)) ||
      !deletedIndexIdentities.has(
        `${gitModeClass(entry.mode)}:${entry.objectId}`,
      )
    ) {
      continue;
    }
    let read = blobReads.get(entry.objectId);
    if (read === undefined) {
      read = readGitBlobObject({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        repositoryRoot: args.snapshot.repositoryRoot,
        objectId: entry.objectId,
        pageLimitBytes: args.pageLimitBytes,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      blobReads.set(entry.objectId, read);
    }
    const blob = await read;
    if (!blob.ok) {
      return blob;
    }
    entry.exactRenameIdentityVerified = blob.content.equals(canonicalContent);
  }

  const [inventoryAfter, configAfter] = await Promise.all([
    readGitWorktreeInventory(context, args.snapshot.repositoryRoot),
    readGitCanonicalizationConfig(context, args.snapshot.repositoryRoot),
  ]);
  if (!inventoryAfter.ok) {
    return inventoryAfter;
  }
  if (!configAfter.ok) {
    return configAfter;
  }
  if (
    !inventoryBefore.inventory.raw.equals(inventoryAfter.inventory.raw) ||
    configBefore.config.autoCrlf !== configAfter.config.autoCrlf ||
    configBefore.config.fileMode !== configAfter.config.fileMode
  ) {
    return gitInspectionFailure(
      'observation_changed',
      'Git worktree inventory or canonicalization policy changed while it was captured.',
    );
  }
  const policiesAfter = await readGitWorktreeCanonicalizationPolicies(
    context,
    args.snapshot.repositoryRoot,
    policyPaths,
    configAfter.config,
  );
  if (!policiesAfter.ok) {
    return policiesAfter;
  }
  if (!policiesBefore.value.raw.equals(policiesAfter.value.raw)) {
    return gitInspectionFailure(
      'observation_changed',
      'Git worktree inventory or canonicalization policy changed while it was captured.',
    );
  }
  for (const observed of observedEntries) {
    if (
      !(await verifyGitWorktreeEntryEvidence({
        repositoryRoot: args.snapshot.repositoryRoot,
        relativePath: observed.entry.path,
        evidence: observed.evidence,
      }))
    ) {
      return gitInspectionFailure(
        'observation_changed',
        'A Git worktree entry changed while the worktree snapshot was captured.',
      );
    }
  }

  return {
    ok: true,
    entries: observedEntries
      .map((observed) => observed.entry)
      .sort((left, right) => Buffer.compare(left.path, right.path)),
    contents: observedEntries
      .map(
        (observed): GitWorktreeContentSnapshot => ({
          path: Buffer.from(observed.entry.path),
          canonicalContent:
            observed.canonicalContent === null
              ? null
              : Buffer.from(observed.canonicalContent),
          projectionBlockReason: observed.projectionBlockReason,
        }),
      )
      .sort((left, right) => Buffer.compare(left.path, right.path)),
  };
}

async function readGitWorktreeInventory(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<
  { ok: true; inventory: GitWorktreeInventory } | GitInspectionReadFailure
> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'ls-files',
      '--cached',
      '--others',
      '--deduplicate',
      '--exclude-standard',
      '--full-name',
      '-z',
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'command_failed',
      'Git could not read the worktree inventory.',
    );
  }
  const records = splitGitNulRecords(observed.stdout);
  if (records === undefined) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid worktree inventory.',
    );
  }
  const paths = new Set<string>();
  const inventory: Buffer[] = [];
  for (const record of records) {
    const key = gitPathKey(record);
    if (!isValidGitRelativePath(record) || paths.has(key)) {
      return gitInspectionFailure(
        'invalid_output',
        'Git returned an invalid or duplicate worktree path.',
      );
    }
    paths.add(key);
    inventory.push(Buffer.from(record));
  }
  return {
    ok: true,
    inventory: {
      raw: Buffer.from(observed.stdout),
      paths: inventory,
    },
  };
}

async function readGitCanonicalizationConfig(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<
  { ok: true; config: GitCanonicalizationConfig } | GitInspectionReadFailure
> {
  const [autoCrlf, fileMode] = await Promise.all([
    readGitConfigValue(context, repositoryRoot, 'core.autocrlf'),
    readGitConfigValue(context, repositoryRoot, 'core.filemode'),
  ]);
  if (!autoCrlf.ok) {
    return autoCrlf;
  }
  const autoCrlfValue = (autoCrlf.value ?? 'false').toLowerCase();
  if (
    autoCrlfValue !== 'false' &&
    autoCrlfValue !== 'true' &&
    autoCrlfValue !== 'input'
  ) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid core.autocrlf value.',
    );
  }
  if (!fileMode.ok) {
    return fileMode;
  }
  const fileModeValue = (fileMode.value ?? 'true').toLowerCase();
  if (fileModeValue !== 'false' && fileModeValue !== 'true') {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid core.filemode value.',
    );
  }
  return {
    ok: true,
    config: {
      autoCrlf: autoCrlfValue,
      fileMode: fileModeValue === 'true',
    },
  };
}

async function readGitConfigValue(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
  key: string,
): Promise<{ ok: true; value: string | null } | GitInspectionReadFailure> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [...GIT_INSPECTION_GLOBAL_ARGUMENTS, 'config', '--get', key],
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode === 1 && observed.stdout.length === 0) {
    return { ok: true, value: null };
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure('command_failed', `Git could not read ${key}.`);
  }
  const value = decodeGitSingleLine(observed.stdout);
  return value === undefined
    ? gitInspectionFailure(
        'invalid_output',
        `Git returned an invalid ${key} value.`,
      )
    : { ok: true, value };
}

async function readGitWorktreeCanonicalizationPolicies(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
  paths: readonly Buffer[],
  config: GitCanonicalizationConfig,
): Promise<
  { ok: true; value: GitCanonicalizationPolicyRead } | GitInspectionReadFailure
> {
  if (paths.length === 0) {
    return {
      ok: true,
      value: { raw: Buffer.alloc(0), policies: new Map() },
    };
  }
  const stdin = Buffer.concat(
    paths.flatMap((path) => [path, Buffer.from([0])]),
  );
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'check-attr',
      '-z',
      '--stdin',
      'crlf',
      'text',
      'eol',
      'ident',
      'filter',
      'working-tree-encoding',
    ],
    initialStdin: stdin,
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'command_failed',
      'Git could not resolve worktree canonicalization attributes.',
    );
  }
  const parsed = parseGitCanonicalizationPolicies(
    observed.stdout,
    paths,
    config,
  );
  if (
    parsed === 'filtered_worktree_comparison_unsupported' ||
    parsed === 'unsupported_worktree_transformation'
  ) {
    return gitInspectionFailure(
      parsed,
      parsed === 'filtered_worktree_comparison_unsupported'
        ? 'Git attributes require an external clean filter.'
        : 'Git attributes require an unsupported working-tree encoding.',
    );
  }
  if (parsed === undefined) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned invalid worktree canonicalization attributes.',
    );
  }
  return {
    ok: true,
    value: {
      raw: Buffer.from(observed.stdout),
      policies: parsed,
    },
  };
}

function parseGitCanonicalizationPolicies(
  raw: Buffer,
  paths: readonly Buffer[],
  config: GitCanonicalizationConfig,
):
  | ReadonlyMap<string, GitWorktreeCanonicalizationPolicy>
  | 'filtered_worktree_comparison_unsupported'
  | 'unsupported_worktree_transformation'
  | undefined {
  const fields = splitGitNulFields(raw);
  if (fields === undefined || fields.length % 3 !== 0) {
    return undefined;
  }
  const expectedPaths = new Map(paths.map((path) => [gitPathKey(path), path]));
  const values = new Map<string, Map<string, string>>();
  for (let offset = 0; offset < fields.length; offset += 3) {
    const path = fields[offset];
    const attribute = fields[offset + 1];
    const rawValue = fields[offset + 2];
    if (
      path === undefined ||
      attribute === undefined ||
      rawValue === undefined
    ) {
      return undefined;
    }
    const key = gitPathKey(path);
    if (!expectedPaths.has(key)) {
      return undefined;
    }
    const attributeName = decodeGitAscii(attribute);
    const value = decodeGitAscii(rawValue);
    if (attributeName === undefined || value === undefined) {
      return undefined;
    }
    const pathValues = values.get(key) ?? new Map<string, string>();
    if (pathValues.has(attributeName)) {
      return undefined;
    }
    pathValues.set(attributeName, value);
    values.set(key, pathValues);
  }

  const policies = new Map<string, GitWorktreeCanonicalizationPolicy>();
  for (const [key] of expectedPaths) {
    const pathValues = values.get(key);
    if (
      pathValues === undefined ||
      pathValues.size !== 6 ||
      pathValues.get('crlf') === undefined ||
      pathValues.get('text') === undefined ||
      pathValues.get('eol') === undefined ||
      pathValues.get('ident') === undefined ||
      pathValues.get('filter') === undefined ||
      pathValues.get('working-tree-encoding') === undefined
    ) {
      return undefined;
    }
    const filter = pathValues.get('filter');
    if (filter !== 'unspecified' && filter !== 'unset' && filter !== 'set') {
      return 'filtered_worktree_comparison_unsupported';
    }
    const text = resolveGitTextPolicy(pathValues, config.autoCrlf);
    const workingTreeEncoding = resolveGitWorkingTreeEncoding(
      pathValues.get('working-tree-encoding'),
    );
    if (workingTreeEncoding === undefined) {
      return 'unsupported_worktree_transformation';
    }
    if (text === undefined) {
      return undefined;
    }
    policies.set(key, {
      text,
      ident: pathValues.get('ident') === 'set',
      workingTreeEncoding,
      indexHasCrLf: false,
    });
  }
  return policies;
}

function resolveGitTextPolicy(
  attributes: ReadonlyMap<string, string>,
  autoCrlf: GitCanonicalizationConfig['autoCrlf'],
): GitWorktreeCanonicalizationPolicy['text'] | undefined {
  const textAttribute = attributes.get('text');
  const legacyCrlf = attributes.get('crlf');
  const eol = attributes.get('eol');
  if (
    textAttribute === undefined ||
    legacyCrlf === undefined ||
    eol === undefined
  ) {
    return undefined;
  }
  const action = resolveGitTextAttribute(textAttribute);
  const legacyAction = resolveGitTextAttribute(legacyCrlf);
  const selected = action === 'unspecified' ? legacyAction : action;
  if (selected === 'raw') {
    return 'raw';
  }
  if (selected === 'text' || selected === 'input') {
    return 'text';
  }
  if (selected === 'auto') {
    return 'auto';
  }
  if (eol === 'lf' || eol === 'crlf') {
    return 'text';
  }
  return autoCrlf === 'false' ? 'raw' : 'auto';
}

function resolveGitTextAttribute(
  value: string,
): 'raw' | 'text' | 'auto' | 'input' | 'unspecified' {
  if (value === 'set') {
    return 'text';
  }
  if (value === 'unset') {
    return 'raw';
  }
  if (value === 'auto') {
    return 'auto';
  }
  if (value === 'input') {
    return 'input';
  }
  return 'unspecified';
}

function resolveGitWorkingTreeEncoding(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined || value === 'set') {
    return undefined;
  }
  return value === 'unset' || value === 'unspecified' || value.length === 0
    ? null
    : value;
}

function splitGitNulFields(raw: Buffer): Buffer[] | undefined {
  if (raw.length === 0) {
    return [];
  }
  if (raw.at(-1) !== 0) {
    return undefined;
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor < raw.length; cursor += 1) {
    if (raw[cursor] === 0) {
      fields.push(raw.subarray(start, cursor));
      start = cursor + 1;
    }
  }
  return fields;
}

export function gitModeContentKind(mode: string): GitComparisonContentKind {
  const modeClass = gitModeClass(mode);
  return modeClass === 'regular' ? 'unknown' : modeClass;
}

export interface GitWorktreeCanonicalizationPolicy {
  text: 'raw' | 'text' | 'auto';
  ident: boolean;
  workingTreeEncoding: string | null;
  indexHasCrLf: boolean;
}

export type GitWorktreeCanonicalizationResult =
  | {
      ok: true;
      canonicalContent: Buffer;
      contentKind: 'text' | 'binary';
    }
  | {
      ok: false;
      reason: 'unsupported_worktree_transformation';
    };

interface GitTextStatistics {
  crLf: number;
  loneCr: number;
  loneLf: number;
  nul: number;
  printable: number;
  nonPrintable: number;
}

export function canonicalizeGitWorktreeContent(
  content: Uint8Array,
  policy: GitWorktreeCanonicalizationPolicy,
): GitWorktreeCanonicalizationResult {
  if (!isGitUtf8IdentityEncoding(policy.workingTreeEncoding)) {
    return { ok: false, reason: 'unsupported_worktree_transformation' };
  }

  const source = Buffer.from(content);
  const statistics = gatherGitTextStatistics(source);
  const contentKind = isGitBinaryContent(statistics) ? 'binary' : 'text';
  const normalizeLineEndings =
    policy.text === 'text' ||
    (policy.text === 'auto' && contentKind === 'text' && !policy.indexHasCrLf);
  const lineNormalized =
    normalizeLineEndings && statistics.crLf > 0
      ? normalizeGitCrLf(source, statistics.crLf)
      : source;
  const canonicalContent = policy.ident
    ? collapseGitIdentExpansions(lineNormalized)
    : Buffer.from(lineNormalized);

  return { ok: true, canonicalContent, contentKind };
}

function isGitUtf8IdentityEncoding(encoding: string | null): boolean {
  if (encoding === null) {
    return true;
  }
  return /^utf-?8$/iu.test(encoding);
}

function gatherGitTextStatistics(content: Buffer): GitTextStatistics {
  let crLf = 0;
  let loneCr = 0;
  let loneLf = 0;
  let nul = 0;
  let printable = 0;
  let nonPrintable = 0;
  for (let index = 0; index < content.length; index += 1) {
    const byte = content[index];
    if (byte === 0x0d) {
      if (content[index + 1] === 0x0a) {
        crLf += 1;
        index += 1;
      } else {
        loneCr += 1;
      }
      continue;
    }
    if (byte === 0x0a) {
      loneLf += 1;
      continue;
    }
    if (byte === 0x7f) {
      nonPrintable += 1;
      continue;
    }
    if (byte !== undefined && byte < 0x20) {
      if (byte === 0x08 || byte === 0x09 || byte === 0x1b || byte === 0x0c) {
        printable += 1;
      } else {
        if (byte === 0) {
          nul += 1;
        }
        nonPrintable += 1;
      }
      continue;
    }
    printable += 1;
  }
  if (content.at(-1) === 0x1a) {
    nonPrintable -= 1;
  }
  return { crLf, loneCr, loneLf, nul, printable, nonPrintable };
}

function isGitBinaryContent(statistics: GitTextStatistics): boolean {
  return (
    statistics.loneCr > 0 ||
    statistics.nul > 0 ||
    Math.floor(statistics.printable / 128) < statistics.nonPrintable
  );
}

function normalizeGitCrLf(content: Buffer, crLfCount: number): Buffer {
  const normalized = Buffer.allocUnsafe(content.length - crLfCount);
  let writeOffset = 0;
  for (let readOffset = 0; readOffset < content.length; readOffset += 1) {
    const byte = content[readOffset];
    if (byte === 0x0d && content[readOffset + 1] === 0x0a) {
      continue;
    }
    if (byte !== undefined) {
      normalized[writeOffset] = byte;
      writeOffset += 1;
    }
  }
  return normalized;
}

function collapseGitIdentExpansions(content: Buffer): Buffer {
  const collapsed = Buffer.allocUnsafe(content.length);
  let readOffset = 0;
  let writeOffset = 0;
  for (;;) {
    const dollarOffset = content.indexOf(0x24, readOffset);
    if (dollarOffset < 0) {
      content.copy(collapsed, writeOffset, readOffset);
      writeOffset += content.length - readOffset;
      break;
    }
    content.copy(collapsed, writeOffset, readOffset, dollarOffset + 1);
    writeOffset += dollarOffset + 1 - readOffset;
    readOffset = dollarOffset + 1;
    if (
      content.length - readOffset <= 3 ||
      content[readOffset] !== 0x49 ||
      content[readOffset + 1] !== 0x64 ||
      content[readOffset + 2] !== 0x3a
    ) {
      continue;
    }
    const closingDollar = content.indexOf(0x24, readOffset + 3);
    if (closingDollar < 0) {
      content.copy(collapsed, writeOffset, readOffset);
      writeOffset += content.length - readOffset;
      break;
    }
    const lineFeed = content.indexOf(0x0a, readOffset + 3);
    if (lineFeed >= 0 && lineFeed < closingDollar) {
      continue;
    }
    collapsed[writeOffset] = 0x49;
    collapsed[writeOffset + 1] = 0x64;
    collapsed[writeOffset + 2] = 0x24;
    writeOffset += 3;
    readOffset = closingDollar + 1;
  }
  return collapsed.subarray(0, writeOffset);
}

export interface GitWorktreeFileCaptureEvidence {
  device: bigint;
  inode: bigint;
  mode: bigint;
  linkCount: bigint;
  size: bigint;
  modifiedAtNs: bigint;
  changedAtNs: bigint;
}

export type GitWorktreeFileCaptureResult =
  | {
      ok: true;
      content: Buffer;
      evidence: GitWorktreeFileCaptureEvidence;
    }
  | {
      ok: false;
      reason:
        | 'entry_missing'
        | 'invalid_path'
        | 'observation_changed'
        | 'resource_limit'
        | 'safe_read_unavailable'
        | 'unsupported_file_type';
    };

class GitWorktreeCaptureError extends Error {
  constructor(
    readonly reason: Exclude<
      GitWorktreeFileCaptureResult,
      { ok: true }
    >['reason'],
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = 'GitWorktreeCaptureError';
  }
}

function isGitIndexStatClean(args: {
  metadata: BigIntStats;
  indexEntry: GitIndexSnapshotEntry;
  indexTimestampNs: bigint | null;
  objectFormat: GitObjectFormat;
  fileMode: boolean;
}): boolean {
  if (
    args.indexEntry.stage !== 0 ||
    args.indexTimestampNs === null ||
    /^0+$/u.test(args.indexEntry.objectId)
  ) {
    return false;
  }
  const modeClass = gitModeClass(args.indexEntry.mode);
  if (
    (modeClass === 'regular' &&
      (!args.metadata.isFile() || args.metadata.isSymbolicLink())) ||
    (modeClass === 'symlink' && !args.metadata.isSymbolicLink()) ||
    (modeClass !== 'regular' && modeClass !== 'symlink')
  ) {
    return false;
  }
  if (
    modeClass === 'regular' &&
    args.fileMode &&
    ((args.metadata.mode & 0o100n) !== 0n) !==
      (args.indexEntry.mode === '100755')
  ) {
    return false;
  }
  const mtime = gitCacheTime(args.metadata.mtimeNs);
  const ctime = gitCacheTime(args.metadata.ctimeNs);
  if (
    mtime === null ||
    ctime === null ||
    args.indexTimestampNs <= args.metadata.mtimeNs ||
    args.metadata.size < 0n ||
    args.metadata.size > 0xffff_ffffn
  ) {
    return false;
  }
  const stat = args.indexEntry.statData;
  if (
    stat.mtimeSeconds !== mtime.seconds ||
    stat.mtimeNanoseconds !== mtime.nanoseconds ||
    stat.ctimeSeconds !== ctime.seconds ||
    stat.ctimeNanoseconds !== ctime.nanoseconds ||
    stat.device !== gitStatUInt32(args.metadata.dev) ||
    stat.inode !== gitStatUInt32(args.metadata.ino) ||
    stat.uid !== gitStatUInt32(args.metadata.uid) ||
    stat.gid !== gitStatUInt32(args.metadata.gid) ||
    stat.size !== Number(args.metadata.size)
  ) {
    return false;
  }
  return !(
    stat.size === 0 &&
    args.indexEntry.objectId !==
      hashGitBlobContent(Buffer.alloc(0), args.objectFormat)
  );
}

function gitCacheTime(
  nanosecondsSinceEpoch: bigint,
): { seconds: number; nanoseconds: number } | null {
  if (nanosecondsSinceEpoch < 0n) {
    return null;
  }
  const seconds = nanosecondsSinceEpoch / 1_000_000_000n;
  if (seconds > 0xffff_ffffn) {
    return null;
  }
  return {
    seconds: Number(seconds),
    nanoseconds: Number(nanosecondsSinceEpoch % 1_000_000_000n),
  };
}

function gitStatUInt32(value: bigint): number {
  return Number(value & 0xffff_ffffn);
}

async function captureGitObservedWorktreeEntry(args: {
  repositoryRoot: string;
  relativePath: Uint8Array;
  objectFormat: GitObjectFormat;
  indexEntry: GitIndexSnapshotEntry | undefined;
  indexTimestampNs: bigint | null;
  fileMode: boolean;
  policy: GitWorktreeCanonicalizationPolicy | undefined;
  maxBytes: number;
}): Promise<GitObservedWorktreeEntryCaptureResult> {
  if (process.platform !== 'linux') {
    return gitInspectionFailure(
      'safe_worktree_read_unavailable',
      'Safe Git worktree entry capture is unavailable on this platform.',
    );
  }
  const segments = parseGitRelativePathSegments(args.relativePath);
  if (segments === undefined) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid worktree path.',
    );
  }

  let currentDirectory: FileHandle | undefined;
  try {
    currentDirectory = await openVerifiedGitDirectory(args.repositoryRoot);
    for (const segment of segments.slice(0, -1)) {
      const previousDirectory = currentDirectory;
      currentDirectory = await openVerifiedGitDirectory(
        procSelfFdChildPath(previousDirectory.fd, segment),
      );
      await previousDirectory.close().catch(() => undefined);
    }
    const finalSegment = segments.at(-1);
    if (finalSegment === undefined) {
      return gitInspectionFailure(
        'invalid_output',
        'Git returned an invalid worktree path.',
      );
    }
    const path = procSelfFdChildPath(currentDirectory.fd, finalSegment);
    let expected: BigIntStats;
    try {
      expected = await lstat(path, { bigint: true });
    } catch (error: unknown) {
      if (readNodeErrorCode(error) === 'ENOENT') {
        return { ok: true, status: 'captured', observed: null };
      }
      throw error;
    }

    if (
      args.indexEntry !== undefined &&
      isGitIndexStatClean({
        metadata: expected,
        indexEntry: args.indexEntry,
        indexTimestampNs: args.indexTimestampNs,
        objectFormat: args.objectFormat,
        fileMode: args.fileMode,
      })
    ) {
      return {
        ok: true,
        status: 'captured',
        observed: {
          entry: {
            path: Buffer.from(args.relativePath),
            mode: args.indexEntry.mode,
            objectId: args.indexEntry.objectId,
            contentKind: gitModeContentKind(args.indexEntry.mode),
            exactRenameIdentityVerified: false,
          },
          evidence: gitWorktreeFileEvidence(expected),
          canonicalContent: null,
          projectionBlockReason: null,
        },
      };
    }

    if (expected.isFile() && !expected.isSymbolicLink()) {
      if (args.policy === undefined) {
        return { ok: true, status: 'needs_policy' };
      }
      const captured = await captureVerifiedGitFile(path, args.maxBytes);
      if (!captured.ok) {
        return gitInspectionFailureForWorktreeCapture(captured);
      }
      const preserveIndexMode =
        !args.fileMode &&
        args.indexEntry !== undefined &&
        gitModeClass(args.indexEntry.mode) === 'regular';
      const mode =
        preserveIndexMode && args.indexEntry !== undefined
          ? args.indexEntry.mode
          : (expected.mode & 0o111n) === 0n
            ? '100644'
            : '100755';
      const canonical = canonicalizeGitWorktreeContent(
        captured.content,
        args.policy,
      );
      if (!canonical.ok) {
        if (args.indexEntry === undefined) {
          return {
            ok: true,
            status: 'captured',
            observed: {
              entry: {
                path: Buffer.from(args.relativePath),
                mode,
                objectId: null,
                contentKind: 'unknown',
                exactRenameIdentityVerified: false,
              },
              evidence: captured.evidence,
              canonicalContent: null,
              projectionBlockReason: 'unsupported_content_transformation',
            },
          };
        }
        return gitInspectionFailure(
          'unsupported_worktree_transformation',
          'Git worktree content requires an unsupported canonicalization transform.',
        );
      }
      return {
        ok: true,
        status: 'captured',
        observed: {
          entry: {
            path: Buffer.from(args.relativePath),
            mode,
            objectId: hashGitBlobContent(
              canonical.canonicalContent,
              args.objectFormat,
            ),
            contentKind: canonical.contentKind,
            exactRenameIdentityVerified: false,
          },
          evidence: captured.evidence,
          canonicalContent: canonical.canonicalContent,
          projectionBlockReason: null,
        },
      };
    }
    if (expected.isSymbolicLink()) {
      const captured = await captureVerifiedGitSymlink(path, args.maxBytes);
      if (!captured.ok) {
        return gitInspectionFailureForWorktreeCapture(captured);
      }
      return {
        ok: true,
        status: 'captured',
        observed: {
          entry: {
            path: Buffer.from(args.relativePath),
            mode: '120000',
            objectId: hashGitBlobContent(captured.content, args.objectFormat),
            contentKind: 'symlink',
            exactRenameIdentityVerified: false,
          },
          evidence: captured.evidence,
          canonicalContent: captured.content,
          projectionBlockReason: null,
        },
      };
    }
    if (expected.isDirectory()) {
      return args.indexEntry?.mode === '160000'
        ? {
            ok: true,
            status: 'captured',
            observed: {
              entry: {
                path: Buffer.from(args.relativePath),
                mode: '160000',
                objectId: null,
                contentKind: 'submodule',
                exactRenameIdentityVerified: false,
              },
              evidence: gitWorktreeFileEvidence(expected),
              canonicalContent: null,
              projectionBlockReason: null,
            },
          }
        : { ok: true, status: 'captured', observed: null };
    }
    return {
      ok: true,
      status: 'captured',
      observed: {
        entry: {
          path: Buffer.from(args.relativePath),
          mode: 'special',
          objectId: null,
          contentKind: 'special',
          exactRenameIdentityVerified: false,
        },
        evidence: gitWorktreeFileEvidence(expected),
        canonicalContent: null,
        projectionBlockReason: null,
      },
    };
  } catch (error: unknown) {
    const failure = gitWorktreeCaptureFailure(error);
    return failure.ok
      ? gitInspectionFailure(
          'command_failed',
          'Safe Git worktree entry capture failed unexpectedly.',
        )
      : gitInspectionFailureForWorktreeCapture(failure);
  } finally {
    await currentDirectory?.close().catch(() => undefined);
  }
}

async function captureVerifiedGitSymlink(
  path: Buffer,
  maxBytes: number,
): Promise<GitWorktreeFileCaptureResult> {
  const expected = await lstat(path, { bigint: true });
  if (!expected.isSymbolicLink()) {
    return { ok: false, reason: 'unsupported_file_type' };
  }
  if (expected.size > BigInt(maxBytes)) {
    return { ok: false, reason: 'resource_limit' };
  }
  const content = await readlink(path, { encoding: 'buffer' });
  if (content.length > maxBytes) {
    return { ok: false, reason: 'resource_limit' };
  }
  const after = await lstat(path, { bigint: true });
  if (
    !after.isSymbolicLink() ||
    !sameGitWorktreeFileEvidence(expected, after)
  ) {
    return { ok: false, reason: 'observation_changed' };
  }
  return {
    ok: true,
    content: Buffer.from(content),
    evidence: gitWorktreeFileEvidence(after),
  };
}

async function verifyGitWorktreeEntryEvidence(args: {
  repositoryRoot: string;
  relativePath: Uint8Array;
  evidence: GitWorktreeFileCaptureEvidence;
}): Promise<boolean> {
  if (process.platform !== 'linux') {
    return false;
  }
  const segments = parseGitRelativePathSegments(args.relativePath);
  if (segments === undefined) {
    return false;
  }
  let currentDirectory: FileHandle | undefined;
  try {
    currentDirectory = await openVerifiedGitDirectory(args.repositoryRoot);
    for (const segment of segments.slice(0, -1)) {
      const previousDirectory = currentDirectory;
      currentDirectory = await openVerifiedGitDirectory(
        procSelfFdChildPath(previousDirectory.fd, segment),
      );
      await previousDirectory.close().catch(() => undefined);
    }
    const finalSegment = segments.at(-1);
    if (finalSegment === undefined) {
      return false;
    }
    const stats = await lstat(
      procSelfFdChildPath(currentDirectory.fd, finalSegment),
      { bigint: true },
    );
    const observed = gitWorktreeFileEvidence(stats);
    return (
      observed.device === args.evidence.device &&
      observed.inode === args.evidence.inode &&
      observed.mode === args.evidence.mode &&
      observed.linkCount === args.evidence.linkCount &&
      observed.size === args.evidence.size &&
      observed.modifiedAtNs === args.evidence.modifiedAtNs &&
      observed.changedAtNs === args.evidence.changedAtNs
    );
  } catch {
    return false;
  } finally {
    await currentDirectory?.close().catch(() => undefined);
  }
}

function gitInspectionFailureForWorktreeCapture(
  failure: Exclude<GitWorktreeFileCaptureResult, { ok: true }>,
): GitInspectionReadFailure {
  if (failure.reason === 'resource_limit') {
    return gitInspectionFailure(
      'resource_limit',
      'A Git worktree entry exceeded the configured capture boundary.',
    );
  }
  if (
    failure.reason === 'entry_missing' ||
    failure.reason === 'observation_changed' ||
    failure.reason === 'unsupported_file_type'
  ) {
    return gitInspectionFailure(
      'observation_changed',
      'A Git worktree entry changed while it was captured.',
    );
  }
  if (failure.reason === 'invalid_path') {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid worktree path.',
    );
  }
  return gitInspectionFailure(
    'command_failed',
    'Safe Git worktree entry capture is unavailable.',
  );
}

export async function captureGitWorktreeFile(args: {
  repositoryRoot: string;
  relativePath: Uint8Array;
  maxBytes: number;
}): Promise<GitWorktreeFileCaptureResult> {
  if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 0) {
    throw new RangeError('Git worktree capture maxBytes must be non-negative');
  }
  if (process.platform !== 'linux') {
    return { ok: false, reason: 'safe_read_unavailable' };
  }

  const segments = parseGitRelativePathSegments(args.relativePath);
  if (segments === undefined) {
    return { ok: false, reason: 'invalid_path' };
  }

  let currentDirectory: FileHandle | undefined;
  try {
    currentDirectory = await openVerifiedGitDirectory(args.repositoryRoot);
    for (const segment of segments.slice(0, -1)) {
      const previousDirectory = currentDirectory;
      currentDirectory = await openVerifiedGitDirectory(
        procSelfFdChildPath(previousDirectory.fd, segment),
      );
      await previousDirectory.close().catch(() => undefined);
    }

    const finalSegment = segments.at(-1);
    if (finalSegment === undefined) {
      return { ok: false, reason: 'invalid_path' };
    }
    return await captureVerifiedGitFile(
      procSelfFdChildPath(currentDirectory.fd, finalSegment),
      args.maxBytes,
    );
  } catch (error: unknown) {
    return gitWorktreeCaptureFailure(error);
  } finally {
    await currentDirectory?.close().catch(() => undefined);
  }
}

async function openVerifiedGitDirectory(
  path: string | Buffer,
): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    const expected = await lstat(path, { bigint: true });
    if (!expected.isDirectory() || expected.isSymbolicLink()) {
      throw new GitWorktreeCaptureError('unsupported_file_type');
    }
    directory = await open(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
    const opened = await directory.stat({ bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new GitWorktreeCaptureError('observation_changed');
    }
    return directory;
  } catch (error: unknown) {
    await directory?.close().catch(() => undefined);
    throw error;
  }
}

async function captureVerifiedGitFile(
  path: Buffer,
  maxBytes: number,
): Promise<GitWorktreeFileCaptureResult> {
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink()) {
    return { ok: false, reason: 'unsupported_file_type' };
  }
  if (expected.size > BigInt(maxBytes)) {
    return { ok: false, reason: 'resource_limit' };
  }

  let file: FileHandle | undefined;
  try {
    file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameGitWorktreeFileEvidence(expected, opened)) {
      return { ok: false, reason: 'observation_changed' };
    }

    const content = await readExactGitWorktreeFile(file, Number(opened.size));
    if (content === undefined) {
      return { ok: false, reason: 'observation_changed' };
    }
    const after = await file.stat({ bigint: true });
    if (!after.isFile() || !sameGitWorktreeFileEvidence(opened, after)) {
      return { ok: false, reason: 'observation_changed' };
    }
    return {
      ok: true,
      content,
      evidence: gitWorktreeFileEvidence(after),
    };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readExactGitWorktreeFile(
  file: FileHandle,
  expectedBytes: number,
): Promise<Buffer | undefined> {
  const content = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const read = await file.read(
      content,
      offset,
      Math.min(WORKTREE_CAPTURE_READ_CHUNK_BYTES, expectedBytes - offset),
      offset,
    );
    if (read.bytesRead === 0) {
      return undefined;
    }
    offset += read.bytesRead;
  }

  const extra = Buffer.allocUnsafe(1);
  const trailing = await file.read(extra, 0, 1, expectedBytes);
  return trailing.bytesRead === 0 ? content : undefined;
}

function gitWorktreeFileEvidence(
  stats: BigIntStats,
): GitWorktreeFileCaptureEvidence {
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    linkCount: stats.nlink,
    size: stats.size,
    modifiedAtNs: stats.mtimeNs,
    changedAtNs: stats.ctimeNs,
  };
}

function sameGitWorktreeFileEvidence(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  const leftEvidence = gitWorktreeFileEvidence(left);
  const rightEvidence = gitWorktreeFileEvidence(right);
  return (
    leftEvidence.device === rightEvidence.device &&
    leftEvidence.inode === rightEvidence.inode &&
    leftEvidence.mode === rightEvidence.mode &&
    leftEvidence.linkCount === rightEvidence.linkCount &&
    leftEvidence.size === rightEvidence.size &&
    leftEvidence.modifiedAtNs === rightEvidence.modifiedAtNs &&
    leftEvidence.changedAtNs === rightEvidence.changedAtNs
  );
}

function procSelfFdChildPath(fd: number, segment: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${PROC_SELF_FD_ROOT}/${String(fd)}/`),
    segment,
  ]);
}

function gitWorktreeCaptureFailure(
  error: unknown,
): GitWorktreeFileCaptureResult {
  if (error instanceof GitWorktreeCaptureError) {
    return { ok: false, reason: error.reason };
  }
  const code = readNodeErrorCode(error);
  if (code === 'ENOENT') {
    return { ok: false, reason: 'entry_missing' };
  }
  if (
    code === 'ELOOP' ||
    code === 'ENOTDIR' ||
    code === 'ENXIO' ||
    code === 'EISDIR'
  ) {
    return { ok: false, reason: 'observation_changed' };
  }
  return { ok: false, reason: 'safe_read_unavailable' };
}
