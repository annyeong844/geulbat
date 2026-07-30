import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { HostCommandRuntime } from '../command-host/contract.js';
import { buildAllowlistedCommandEnv } from './command-environment.js';
import { runHostRoutedSystemCommandBytes } from './host-routed-command.js';

const PORTABLE_PROCESS_ENV_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const WINDOWS_PROCESS_ENV_KEYS = [
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'SystemDrive',
  'SystemRoot',
  'WINDIR',
  'windir',
] as const;

export const GIT_INSPECTION_GLOBAL_ARGUMENTS = [
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
] as const;

export function buildGitInspectionEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const nullDevice = platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...buildAllowlistedCommandEnv(
      [
        ...PORTABLE_PROCESS_ENV_KEYS,
        ...(platform === 'win32' ? WINDOWS_PROCESS_ENV_KEYS : []),
      ],
      sourceEnv,
    ),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
  };
}

interface GitTreeSnapshotEntry {
  mode: string;
  objectId: string;
  objectType: 'blob' | 'commit';
  path: Buffer;
}

interface GitIndexStatData {
  ctimeSeconds: number;
  ctimeNanoseconds: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  device: number;
  inode: number;
  uid: number;
  gid: number;
  size: number;
  flags: number;
}

interface GitIndexSnapshotEntry {
  mode: string;
  objectId: string;
  stage: 0 | 1 | 2 | 3;
  path: Buffer;
  statData: GitIndexStatData;
}

export type GitObjectFormat = 'sha1' | 'sha256';

export interface GitBranchSnapshot {
  name: string | null;
  detached: boolean;
}

export interface GitObjectIndexSnapshot {
  repositoryRoot: string;
  objectFormat: GitObjectFormat;
  headObjectId: string | null;
  branch: GitBranchSnapshot;
  indexTimestampNs: bigint | null;
  headEntries: readonly GitTreeSnapshotEntry[];
  indexEntries: readonly GitIndexSnapshotEntry[];
}

export type GitInspectionReadFailureReason =
  | 'aborted'
  | 'bare_repository'
  | 'command_failed'
  | 'filtered_worktree_comparison_unsupported'
  | 'invalid_object_id'
  | 'invalid_output'
  | 'not_repository'
  | 'object_unavailable'
  | 'observation_changed'
  | 'resource_limit'
  | 'safe_worktree_read_unavailable'
  | 'unsupported_worktree_transformation';

export interface GitInspectionReadFailure {
  ok: false;
  reason: GitInspectionReadFailureReason;
  message: string;
}

export type GitObjectIndexSnapshotResult =
  | { ok: true; snapshot: GitObjectIndexSnapshot }
  | GitInspectionReadFailure;

export type GitBlobReadResult =
  | { ok: true; content: Buffer }
  | GitInspectionReadFailure;

export interface GitInspectionCommandContext {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  signal?: AbortSignal;
}

export interface GitInspectionCommandSuccess {
  ok: true;
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type GitInspectionCommandResult =
  | GitInspectionCommandSuccess
  | GitInspectionReadFailure;

export async function captureGitObjectIndexSnapshot(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  workingDirectory: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  signal?: AbortSignal;
}): Promise<GitObjectIndexSnapshotResult> {
  const context: GitInspectionCommandContext = {
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    pageLimitBytes: args.pageLimitBytes,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  const [bare, root] = await Promise.all([
    runGitInspectionCommand({
      ...context,
      cwd: args.workingDirectory,
      commandArgs: [
        ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
        'rev-parse',
        '--is-bare-repository',
      ],
    }),
    runGitInspectionCommand({
      ...context,
      cwd: args.workingDirectory,
      commandArgs: [
        ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
      ],
    }),
  ]);
  if (!bare.ok) {
    return bare;
  }
  if (bare.exitCode !== 0) {
    return gitInspectionFailure(
      'not_repository',
      'Git could not resolve a repository from the selected working directory.',
    );
  }
  const bareValue = decodeGitSingleLine(bare.stdout);
  if (bareValue === 'true') {
    return gitInspectionFailure(
      'bare_repository',
      'Bare repositories are not reviewable as a worktree.',
    );
  }
  if (bareValue !== 'false') {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid bare-repository classification.',
    );
  }

  if (!root.ok) {
    return root;
  }
  if (root.exitCode !== 0) {
    return gitInspectionFailure(
      'not_repository',
      'Git could not resolve the repository worktree root.',
    );
  }
  const repositoryRoot = decodeGitSingleLine(root.stdout);
  if (repositoryRoot === undefined || repositoryRoot.length === 0) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid repository worktree root.',
    );
  }

  const [objectFormatBefore, branchBefore, headBefore, indexBefore] =
    await Promise.all([
      readGitObjectFormat(context, repositoryRoot),
      readGitBranch(context, repositoryRoot),
      readGitHeadObjectId(context, repositoryRoot),
      readGitIndexEntries(context, repositoryRoot),
    ]);
  if (!objectFormatBefore.ok) {
    return objectFormatBefore;
  }
  if (!branchBefore.ok) {
    return branchBefore;
  }
  if (!headBefore.ok) {
    return headBefore;
  }
  if (!indexBefore.ok) {
    return indexBefore;
  }
  const headEntries =
    headBefore.objectId === null
      ? { ok: true as const, entries: [] as GitTreeSnapshotEntry[] }
      : await readGitHeadEntries(context, repositoryRoot, headBefore.objectId);
  if (!headEntries.ok) {
    return headEntries;
  }
  const [indexAfter, headAfter, branchAfter, objectFormatAfter] =
    await Promise.all([
      readGitIndexEntries(context, repositoryRoot),
      readGitHeadObjectId(context, repositoryRoot),
      readGitBranch(context, repositoryRoot),
      readGitObjectFormat(context, repositoryRoot),
    ]);
  if (!indexAfter.ok) {
    return indexAfter;
  }
  if (!headAfter.ok) {
    return headAfter;
  }
  if (!branchAfter.ok) {
    return branchAfter;
  }
  if (!objectFormatAfter.ok) {
    return objectFormatAfter;
  }
  if (
    objectFormatBefore.objectFormat !== objectFormatAfter.objectFormat ||
    branchBefore.branch.name !== branchAfter.branch.name ||
    branchBefore.branch.detached !== branchAfter.branch.detached ||
    headBefore.objectId !== headAfter.objectId ||
    !indexBefore.raw.equals(indexAfter.raw) ||
    indexBefore.timestampNs !== indexAfter.timestampNs
  ) {
    return gitInspectionFailure(
      'observation_changed',
      'Git HEAD or index changed while the object/index snapshot was captured.',
    );
  }

  return {
    ok: true,
    snapshot: {
      repositoryRoot,
      objectFormat: objectFormatBefore.objectFormat,
      headObjectId: headBefore.objectId,
      branch: branchBefore.branch,
      indexTimestampNs: indexBefore.timestampNs,
      headEntries: headEntries.entries,
      indexEntries: indexBefore.entries,
    },
  };
}

export async function readGitBlobObject(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  repositoryRoot: string;
  objectId: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  signal?: AbortSignal;
}): Promise<GitBlobReadResult> {
  if (!GIT_OBJECT_ID_PATTERN.test(args.objectId)) {
    return gitInspectionFailure(
      'invalid_object_id',
      'Git blob reads require one full hexadecimal object id.',
    );
  }
  const observed = await runGitInspectionCommand({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    pageLimitBytes: args.pageLimitBytes,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    cwd: args.repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'cat-file',
      'blob',
      args.objectId,
    ],
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'object_unavailable',
      'Git could not read the requested blob object without external recovery.',
    );
  }
  return { ok: true, content: observed.stdout };
}

export async function runGitInspectionCommand(
  args: GitInspectionCommandContext & {
    cwd: string;
    commandArgs: readonly string[];
    initialStdin?: Uint8Array;
  },
): Promise<GitInspectionCommandResult> {
  const observed = await runHostRoutedSystemCommandBytes({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    pageLimitBytes: args.pageLimitBytes,
    invocation: {
      executable: 'git',
      args: args.commandArgs,
      cwd: args.cwd,
      env: buildGitInspectionEnvironment(),
      ...(args.initialStdin === undefined
        ? {}
        : { initialStdin: args.initialStdin }),
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    },
  });
  if (!observed.ok) {
    return gitInspectionFailure(
      observed.aborted ? 'aborted' : 'command_failed',
      observed.message,
    );
  }
  if (
    observed.snapshot.status === 'output_limit_exceeded' ||
    observed.snapshot.outputLimitExceeded !== null
  ) {
    return gitInspectionFailure(
      'resource_limit',
      'Git inspection output exceeded the configured command boundary.',
    );
  }
  if (
    observed.snapshot.status !== 'exit' ||
    observed.snapshot.exitCode === null
  ) {
    return gitInspectionFailure(
      observed.snapshot.status === 'cancelled' ? 'aborted' : 'command_failed',
      `Git inspection ended with status ${observed.snapshot.status}.`,
    );
  }
  return {
    ok: true,
    exitCode: observed.snapshot.exitCode,
    stdout: observed.stdout,
    stderr: observed.stderr,
  };
}

async function readGitObjectFormat(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<
  { ok: true; objectFormat: GitObjectFormat } | GitInspectionReadFailure
> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'rev-parse',
      '--show-object-format',
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  const objectFormat = decodeGitSingleLine(observed.stdout);
  if (
    observed.exitCode !== 0 ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256')
  ) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an unsupported repository object format.',
    );
  }
  return { ok: true, objectFormat };
}

async function readGitHeadObjectId(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<{ ok: true; objectId: string | null } | GitInspectionReadFailure> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD^{commit}',
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode === 1) {
    return { ok: true, objectId: null };
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'command_failed',
      'Git could not resolve HEAD.',
    );
  }
  const objectId = decodeGitSingleLine(observed.stdout);
  if (objectId === undefined || !GIT_OBJECT_ID_PATTERN.test(objectId)) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid HEAD object id.',
    );
  }
  return { ok: true, objectId };
}

async function readGitBranch(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<{ ok: true; branch: GitBranchSnapshot } | GitInspectionReadFailure> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode === 1) {
    return { ok: true, branch: { name: null, detached: true } };
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'command_failed',
      'Git could not resolve the current branch.',
    );
  }
  const name = decodeGitSingleLine(observed.stdout);
  if (name === undefined || name.length === 0) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid current branch.',
    );
  }
  return { ok: true, branch: { name, detached: false } };
}

async function readGitHeadEntries(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
  headObjectId: string,
): Promise<
  { ok: true; entries: GitTreeSnapshotEntry[] } | GitInspectionReadFailure
> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      headObjectId,
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  if (observed.exitCode !== 0) {
    return gitInspectionFailure(
      'command_failed',
      'Git could not read the captured HEAD tree.',
    );
  }
  const entries = parseGitTreeEntries(observed.stdout);
  return entries === undefined
    ? gitInspectionFailure(
        'invalid_output',
        'Git returned an invalid HEAD tree inventory.',
      )
    : { ok: true, entries };
}

async function readGitIndexEntries(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<
  | {
      ok: true;
      raw: Buffer;
      timestampNs: bigint | null;
      entries: GitIndexSnapshotEntry[];
    }
  | GitInspectionReadFailure
> {
  const indexPath = await readGitIndexPath(context, repositoryRoot);
  if (!indexPath.ok) {
    return indexPath;
  }
  const timestampBefore = await readGitIndexTimestamp(indexPath.path);
  if (!timestampBefore.ok) {
    return timestampBefore;
  }
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'ls-files',
      '--stage',
      '--debug',
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
      'Git could not read the captured index.',
    );
  }
  const timestampAfter = await readGitIndexTimestamp(indexPath.path);
  if (!timestampAfter.ok) {
    return timestampAfter;
  }
  if (timestampBefore.timestampNs !== timestampAfter.timestampNs) {
    return gitInspectionFailure(
      'observation_changed',
      'Git HEAD or index changed while the object/index snapshot was captured.',
    );
  }
  const entries = parseGitIndexEntries(observed.stdout);
  return entries === undefined
    ? gitInspectionFailure(
        'invalid_output',
        'Git returned an invalid index inventory.',
      )
    : {
        ok: true,
        raw: observed.stdout,
        timestampNs: timestampBefore.timestampNs,
        entries,
      };
}

async function readGitIndexPath(
  context: GitInspectionCommandContext,
  repositoryRoot: string,
): Promise<{ ok: true; path: string } | GitInspectionReadFailure> {
  const observed = await runGitInspectionCommand({
    ...context,
    cwd: repositoryRoot,
    commandArgs: [
      ...GIT_INSPECTION_GLOBAL_ARGUMENTS,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ],
  });
  if (!observed.ok) {
    return observed;
  }
  const path = decodeGitSingleLine(observed.stdout);
  if (
    observed.exitCode !== 0 ||
    path === undefined ||
    path.length === 0 ||
    !isAbsolute(path)
  ) {
    return gitInspectionFailure(
      'invalid_output',
      'Git returned an invalid index path.',
    );
  }
  return { ok: true, path };
}

async function readGitIndexTimestamp(
  path: string,
): Promise<
  { ok: true; timestampNs: bigint | null } | GitInspectionReadFailure
> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return gitInspectionFailure(
        'invalid_output',
        'Git index path is not a regular file.',
      );
    }
    return { ok: true, timestampNs: metadata.mtimeNs };
  } catch (error: unknown) {
    if (readNodeErrorCode(error) === 'ENOENT') {
      return { ok: true, timestampNs: null };
    }
    return gitInspectionFailure(
      'command_failed',
      'Git index metadata could not be read.',
    );
  }
}

function parseGitTreeEntries(raw: Buffer): GitTreeSnapshotEntry[] | undefined {
  const records = splitGitNulRecords(raw);
  if (records === undefined) {
    return undefined;
  }
  const entries: GitTreeSnapshotEntry[] = [];
  const paths = new Set<string>();
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab <= 0) {
      return undefined;
    }
    const header = decodeGitAscii(record.subarray(0, tab));
    const matched =
      header?.match(
        /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u,
      ) ?? null;
    const path = record.subarray(tab + 1);
    if (
      matched === null ||
      !isValidGitRelativePath(path) ||
      paths.has(gitPathKey(path))
    ) {
      return undefined;
    }
    const [, mode, objectType, objectId] = matched;
    if (
      mode === undefined ||
      objectId === undefined ||
      (objectType !== 'blob' && objectType !== 'commit')
    ) {
      return undefined;
    }
    paths.add(gitPathKey(path));
    entries.push({
      mode,
      objectId,
      objectType,
      path: Buffer.from(path),
    });
  }
  return entries.sort((left, right) => Buffer.compare(left.path, right.path));
}

function parseGitIndexEntries(
  raw: Buffer,
): GitIndexSnapshotEntry[] | undefined {
  const entries: GitIndexSnapshotEntry[] = [];
  const pathStages = new Set<string>();
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf(0, offset);
    if (nul < 0) {
      return undefined;
    }
    const record = raw.subarray(offset, nul);
    const tab = record.indexOf(0x09);
    if (tab <= 0) {
      return undefined;
    }
    const header = decodeGitAscii(record.subarray(0, tab));
    const matched =
      header?.match(/^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u) ??
      null;
    const path = record.subarray(tab + 1);
    if (matched === null || !isValidGitRelativePath(path)) {
      return undefined;
    }
    const [, mode, objectId, stageText] = matched;
    const stage = stageText === undefined ? Number.NaN : Number(stageText);
    const pathStage = `${gitPathKey(path)}:${String(stage)}`;
    if (
      mode === undefined ||
      objectId === undefined ||
      (stage !== 0 && stage !== 1 && stage !== 2 && stage !== 3) ||
      pathStages.has(pathStage)
    ) {
      return undefined;
    }
    pathStages.add(pathStage);
    const debugEnd = findGitIndexDebugRecordEnd(raw, nul + 1);
    if (debugEnd === undefined) {
      return undefined;
    }
    const statData = parseGitIndexStatData(raw.subarray(nul + 1, debugEnd));
    if (statData === undefined) {
      return undefined;
    }
    entries.push({
      mode,
      objectId,
      stage,
      path: Buffer.from(path),
      statData,
    });
    offset = debugEnd;
  }
  return entries.sort(
    (left, right) =>
      Buffer.compare(left.path, right.path) || left.stage - right.stage,
  );
}

function findGitIndexDebugRecordEnd(
  raw: Buffer,
  start: number,
): number | undefined {
  let cursor = start;
  for (let line = 0; line < 5; line += 1) {
    const newline = raw.indexOf(0x0a, cursor);
    if (newline < 0) {
      return undefined;
    }
    cursor = newline + 1;
  }
  return cursor;
}

function parseGitIndexStatData(raw: Buffer): GitIndexStatData | undefined {
  const value = decodeGitAscii(raw);
  const matched =
    value?.match(
      /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([0-9a-f]+)\n$/u,
    ) ?? null;
  if (matched === null) {
    return undefined;
  }
  const decimalValues = matched
    .slice(1, 10)
    .map((field) => (field === undefined ? Number.NaN : Number(field)));
  if (
    decimalValues.length !== 9 ||
    decimalValues.some(
      (field) =>
        !Number.isSafeInteger(field) || field < 0 || field > 0xffff_ffff,
    ) ||
    (decimalValues[1] ?? 1_000_000_000) >= 1_000_000_000 ||
    (decimalValues[3] ?? 1_000_000_000) >= 1_000_000_000
  ) {
    return undefined;
  }
  const flagsText = matched[10];
  const flags =
    flagsText === undefined ? Number.NaN : Number.parseInt(flagsText, 16);
  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff_ffff) {
    return undefined;
  }
  const [
    ctimeSeconds,
    ctimeNanoseconds,
    mtimeSeconds,
    mtimeNanoseconds,
    device,
    inode,
    uid,
    gid,
    size,
  ] = decimalValues;
  if (
    ctimeSeconds === undefined ||
    ctimeNanoseconds === undefined ||
    mtimeSeconds === undefined ||
    mtimeNanoseconds === undefined ||
    device === undefined ||
    inode === undefined ||
    uid === undefined ||
    gid === undefined ||
    size === undefined
  ) {
    return undefined;
  }
  return {
    ctimeSeconds,
    ctimeNanoseconds,
    mtimeSeconds,
    mtimeNanoseconds,
    device,
    inode,
    uid,
    gid,
    size,
    flags,
  };
}

export function splitGitNulRecords(raw: Buffer): Buffer[] | undefined {
  if (raw.length === 0) {
    return [];
  }
  if (raw.at(-1) !== 0) {
    return undefined;
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor < raw.length; cursor += 1) {
    if (raw[cursor] !== 0) {
      continue;
    }
    if (cursor === start) {
      return undefined;
    }
    records.push(raw.subarray(start, cursor));
    start = cursor + 1;
  }
  return records;
}

export function decodeGitAscii(value: Buffer): string | undefined {
  for (const byte of value) {
    if (byte > 0x7f) {
      return undefined;
    }
  }
  return value.toString('ascii');
}

export function decodeGitSingleLine(value: Buffer): string | undefined {
  if (value.length < 2 || value.at(-1) !== 0x0a) {
    return undefined;
  }
  const content = value.subarray(0, -1);
  if (content.includes(0) || content.includes(0x0a) || content.includes(0x0d)) {
    return undefined;
  }
  try {
    return STRICT_UTF8_DECODER.decode(content);
  } catch {
    return undefined;
  }
}

export function isValidGitRelativePath(value: Buffer): boolean {
  return parseGitRelativePathSegments(value) !== undefined;
}

export function gitPathKey(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

export function gitModeClass(
  mode: string,
): 'regular' | 'submodule' | 'symlink' | 'unknown' {
  if (mode === '100644' || mode === '100755') {
    return 'regular';
  }
  if (mode === '120000') {
    return 'symlink';
  }
  if (mode === '160000') {
    return 'submodule';
  }
  return 'unknown';
}

export function parseGitRelativePathSegments(
  value: Uint8Array,
): Buffer[] | undefined {
  const path = Buffer.from(value);
  if (path.length === 0 || path[0] === 0x2f || path.includes(0)) {
    return undefined;
  }

  const segments: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= path.length; cursor += 1) {
    if (cursor < path.length && path[cursor] !== 0x2f) {
      continue;
    }
    const segment = path.subarray(start, cursor);
    if (
      segment.length === 0 ||
      (segment.length === 1 && segment[0] === 0x2e) ||
      (segment.length === 2 && segment[0] === 0x2e && segment[1] === 0x2e)
    ) {
      return undefined;
    }
    segments.push(Buffer.from(segment));
    start = cursor + 1;
  }
  return segments;
}

export function sameGitObjectIndexSnapshot(
  left: GitObjectIndexSnapshot,
  right: GitObjectIndexSnapshot,
): boolean {
  return (
    left.repositoryRoot === right.repositoryRoot &&
    left.objectFormat === right.objectFormat &&
    left.headObjectId === right.headObjectId &&
    left.branch.name === right.branch.name &&
    left.branch.detached === right.branch.detached &&
    left.indexTimestampNs === right.indexTimestampNs &&
    left.headEntries.length === right.headEntries.length &&
    left.headEntries.every((entry, index) => {
      const peer = right.headEntries[index];
      return (
        peer !== undefined &&
        entry.mode === peer.mode &&
        entry.objectId === peer.objectId &&
        entry.objectType === peer.objectType &&
        entry.path.equals(peer.path)
      );
    }) &&
    left.indexEntries.length === right.indexEntries.length &&
    left.indexEntries.every((entry, index) => {
      const peer = right.indexEntries[index];
      return (
        peer !== undefined &&
        entry.mode === peer.mode &&
        entry.objectId === peer.objectId &&
        entry.stage === peer.stage &&
        entry.path.equals(peer.path) &&
        sameGitIndexStatData(entry.statData, peer.statData)
      );
    })
  );
}

function sameGitIndexStatData(
  left: GitIndexStatData,
  right: GitIndexStatData,
): boolean {
  return (
    left.ctimeSeconds === right.ctimeSeconds &&
    left.ctimeNanoseconds === right.ctimeNanoseconds &&
    left.mtimeSeconds === right.mtimeSeconds &&
    left.mtimeNanoseconds === right.mtimeNanoseconds &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.flags === right.flags
  );
}

export function gitInspectionFailure(
  reason: GitInspectionReadFailureReason,
  message: string,
): GitInspectionReadFailure {
  return { ok: false, reason, message };
}

export function readNodeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}
