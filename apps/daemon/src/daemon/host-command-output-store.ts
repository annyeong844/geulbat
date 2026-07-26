import {
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeTextFileAtomically } from './utils/atomic-file.js';

export type HostCommandOutputStream = 'stdout' | 'stderr';

export type HostCommandStatus =
  | 'running'
  | 'exit'
  | 'crash'
  | 'timeout'
  | 'cancelled'
  | 'signal'
  | 'output_limit_exceeded'
  | 'output_store_failed'
  | 'daemon_shutdown'
  | 'daemon_restart_interrupted'
  | 'command_host_interrupted';

export interface HostCommandSnapshot {
  outputRef: string | null;
  status: HostCommandStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  outputComplete: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutChars: number | null;
  stderrChars: number | null;
  durationMs: number;
  firstOutputAfterMs: number | null;
  revision: number;
  stdinOpen: boolean;
  outputLimitExceeded: {
    stream: HostCommandOutputStream;
    maxOutputBytesPerStream: number;
  } | null;
  stdoutOmittedBytes?: number;
  stderrOmittedBytes?: number;
  terminationReason?: string;
  outputPersistFailed?: boolean;
}

export interface HostCommandOutputPage {
  stream: HostCommandOutputStream;
  offsetBytes: number;
  endOffsetBytes: number;
  totalBytes: number;
  limitBytes: number;
  hasMore: boolean;
  nextOffsetBytes: number | null;
  content: string;
  contentStartOffset?: number;
  earliestAvailableOffset?: number;
}

/**
 * P7.5 spec v4 §5.4 — 산출물 저장 포맷의 major.
 *
 * A안(major 내 영구 additive): 같은 major 안에서는 필드를 더하기만 하고,
 * 과거 major-N 산출물은 언제까지나 계속 읽는다. 오래된 transcript가 가진
 * N 시절 outputRef도 N+k 데몬에서 그대로 조회된다(T22). major를 올리는
 * 변경은 실제 breaking storage 변경뿐이며 본 스펙의 개정을 요구한다.
 * 미지 major는 삭제·재구성 없이 격리한다.
 */
export const HOST_COMMAND_ARTIFACT_FORMAT_VERSION = 1;

export interface HostCommandMetadata {
  /**
   * §5.4 저장 포맷 major. W3까지의 산출물은 `schemaVersion`만 갖고 있으므로
   * 읽을 때는 둘 중 있는 쪽을 쓰고, 쓸 때는 둘 다 남긴다.
   */
  formatVersion?: number;
  schemaVersion: 1;
  /** §5.4 필수 필드. 구 산출물에는 없고 outputRef에서 파생된다. */
  sessionId?: string;
  outputRef: string;
  threadId: string;
  runId: string;
  callId: string;
  status: HostCommandStatus;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutChars: number | null;
  stderrChars: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  firstOutputAfterMs: number | null;
  revision: number;
  stdinOpen: boolean;
  outputLimitExceeded: HostCommandSnapshot['outputLimitExceeded'];
  stdoutBaseOffset?: number;
  stderrBaseOffset?: number;
  terminationReason?: string;
  finalRevision?: number;
  outputPersistFailed?: boolean;
}

export interface HostCommandPaths {
  directory: string;
  metadata: string;
  stdout: string;
  stderr: string;
}

interface PersistedHostCommand {
  metadata: HostCommandMetadata;
  paths: HostCommandPaths;
}

const OUTPUT_REF_PREFIX = 'command-output:';
const UTF8_MAX_CODE_POINT_BYTES = 4;

/**
 * 스레드가 아니라 **데몬 자신이 소유한** 세션의 owner 자리 (P7.6 §5.1).
 *
 * ref와 산출물 경로는 소유자를 한 segment로 나르는데, MCP 서버처럼 어떤
 * 스레드의 것도 아닌 세션에는 담을 threadId가 없다. 콜론은 스레드 id 형식
 * (UUID)에 나타날 수 없으므로 실제 스레드와 절대 충돌하지 않는다.
 */
export const SYSTEM_SESSION_OWNER = 'system:command-host';

export function buildHostCommandOutputRef(args: {
  threadId: string;
  sessionId: string;
}): string {
  return `${OUTPUT_REF_PREFIX}${encodeRefPart(args.threadId)}/${args.sessionId}`;
}

export function parseHostCommandOutputRef(
  outputRef: string,
):
  | { ok: true; threadId: string; sessionId: string }
  | { ok: false; reasonCode: 'invalid_args'; message: string } {
  if (!outputRef.startsWith(OUTPUT_REF_PREFIX)) {
    return {
      ok: false,
      reasonCode: 'invalid_args',
      message: 'outputRef is not a host command output reference.',
    };
  }
  const parts = outputRef.slice(OUTPUT_REF_PREFIX.length).split('/');
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !/^[0-9a-f-]{36}$/u.test(parts[1])
  ) {
    return {
      ok: false,
      reasonCode: 'invalid_args',
      message: 'host command output reference is malformed.',
    };
  }
  try {
    return {
      ok: true,
      threadId: decodeURIComponent(parts[0]),
      sessionId: parts[1],
    };
  } catch {
    return {
      ok: false,
      reasonCode: 'invalid_args',
      message: 'host command output reference is malformed.',
    };
  }
}

export function buildHostCommandPaths(args: {
  stateRoot: string;
  threadId: string;
  outputRef: string;
}): HostCommandPaths {
  const parsed = parseHostCommandOutputRef(args.outputRef);
  if (!parsed.ok || parsed.threadId !== args.threadId) {
    throw new Error('host command output reference does not match thread');
  }
  const directory = join(
    args.stateRoot,
    '.geulbat',
    'tool-outputs',
    encodeRefPart(args.threadId),
    'command-sessions',
    parsed.sessionId,
  );
  return {
    directory,
    metadata: join(directory, 'metadata.json'),
    stdout: join(directory, 'stdout.txt'),
    stderr: join(directory, 'stderr.txt'),
  };
}

export async function writeHostCommandMetadata(args: {
  paths: HostCommandPaths;
  metadata: HostCommandMetadata;
}): Promise<void> {
  await writeTextFileAtomically(
    args.paths.metadata,
    `${JSON.stringify(args.metadata, null, 2)}\n`,
  );
}

export async function readPersistedHostCommand(args: {
  stateRoot: string;
  threadId: string;
  outputRef: string;
}): Promise<
  | { ok: true; value: PersistedHostCommand }
  | {
      ok: false;
      reasonCode: 'not_found' | 'output_store_failed';
      message: string;
    }
> {
  const paths = buildHostCommandPaths(args);
  let raw: string;
  try {
    raw = await readFile(paths.metadata, 'utf8');
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return {
        ok: false,
        reasonCode: 'not_found',
        message: 'host command output was not found.',
      };
    }
    return {
      ok: false,
      reasonCode: 'output_store_failed',
      message: getErrorMessage(error),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reasonCode: 'output_store_failed',
      message: 'host command output metadata is not valid JSON.',
    };
  }
  if (!isHostCommandMetadata(value, args.outputRef, args.threadId)) {
    return {
      ok: false,
      reasonCode: 'output_store_failed',
      message: 'host command output metadata does not match its reference.',
    };
  }
  return { ok: true, value: { metadata: value, paths } };
}

export async function markPersistedHostCommandInterrupted(
  record: PersistedHostCommand,
): Promise<
  | { ok: true; value: PersistedHostCommand }
  | {
      ok: false;
      reasonCode: 'output_store_failed';
      message: string;
    }
> {
  try {
    const [stdoutStats, stderrStats] = await Promise.all([
      stat(record.paths.stdout),
      stat(record.paths.stderr),
    ]);
    const metadata: HostCommandMetadata = {
      ...record.metadata,
      status: 'daemon_restart_interrupted',
      exitCode: null,
      stdoutBytes: stdoutStats.size,
      stderrBytes: stderrStats.size,
      stdoutChars: null,
      stderrChars: null,
      finishedAtMs: Date.now(),
      stdinOpen: false,
      revision: record.metadata.revision + 1,
    };
    await writeHostCommandMetadata({ paths: record.paths, metadata });
    return { ok: true, value: { ...record, metadata } };
  } catch (error: unknown) {
    return {
      ok: false,
      reasonCode: 'output_store_failed',
      message: getErrorMessage(error),
    };
  }
}

export async function readHostCommandOutputPage(args: {
  paths: HostCommandPaths;
  page:
    | {
        stream: HostCommandOutputStream;
        offsetBytes: number;
        limitBytes: number;
      }
    | undefined;
  inlineMaxBytes: number;
}): Promise<
  | { ok: true; value: HostCommandOutputPage | null }
  | {
      ok: false;
      reasonCode: 'invalid_args' | 'output_store_failed';
      message: string;
    }
> {
  if (args.page === undefined) {
    return { ok: true, value: null };
  }
  if (args.page.limitBytes > args.inlineMaxBytes) {
    return {
      ok: false,
      reasonCode: 'invalid_args',
      message: `limitBytes exceeds the configured inline result budget of ${args.inlineMaxBytes} bytes.`,
    };
  }
  return await readUtf8OutputPage({
    path: args.page.stream === 'stdout' ? args.paths.stdout : args.paths.stderr,
    ...args.page,
  });
}

export function snapshotFromHostCommandMetadata(
  metadata: HostCommandMetadata,
): HostCommandSnapshot {
  return {
    outputRef: metadata.outputRef,
    status: metadata.status,
    exitCode: metadata.exitCode,
    stdout: null,
    stderr: null,
    outputComplete: false,
    stdoutBytes: metadata.stdoutBytes,
    stderrBytes: metadata.stderrBytes,
    stdoutChars: metadata.stdoutChars,
    stderrChars: metadata.stderrChars,
    durationMs: (metadata.finishedAtMs ?? Date.now()) - metadata.startedAtMs,
    firstOutputAfterMs: metadata.firstOutputAfterMs,
    revision: metadata.revision,
    stdinOpen: false,
    outputLimitExceeded: metadata.outputLimitExceeded,
    ...(metadata.stdoutBaseOffset === undefined
      ? {}
      : { stdoutOmittedBytes: metadata.stdoutBaseOffset }),
    ...(metadata.stderrBaseOffset === undefined
      ? {}
      : { stderrOmittedBytes: metadata.stderrBaseOffset }),
    ...(metadata.terminationReason === undefined
      ? {}
      : { terminationReason: metadata.terminationReason }),
    ...(metadata.outputPersistFailed === true
      ? { outputPersistFailed: true }
      : {}),
  };
}

export async function removeHostCommandDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    await removeEmptyParent(dirname(path));
  } catch {
    // Retained output is authoritative; cleanup failure must not erase the
    // command result or cause a successful process to be reported as failed.
  }
}

export async function pruneUnreferencedThreadHostCommandOutputs(args: {
  stateRoot: string;
  threadId: string;
  previousOutputRefs: ReadonlySet<string>;
  retainedOutputRefs: ReadonlySet<string>;
}): Promise<number> {
  let deleted = 0;
  for (const outputRef of args.previousOutputRefs) {
    if (args.retainedOutputRefs.has(outputRef)) {
      continue;
    }
    const parsed = parseHostCommandOutputRef(outputRef);
    if (!parsed.ok || parsed.threadId !== args.threadId) {
      continue;
    }
    const paths = buildHostCommandPaths({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef,
    });
    try {
      await rm(paths.directory, { recursive: true, force: false });
      deleted += 1;
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      continue;
    }
    await removeEmptyDirectoryForPrune(dirname(paths.directory));
    await removeEmptyDirectoryForPrune(dirname(dirname(paths.directory)));
  }
  return deleted;
}

export interface PersistedHostCommandLocation {
  outputRef: string;
  threadId: string;
  sessionId: string;
  paths: HostCommandPaths;
}

/**
 * stateRoot 아래 command-session 디렉터리 열거. 기동 복구(P7.5 §5.2)와
 * 도달 불가능 산출물 GC(§5.6)가 같은 레이아웃 지식을 공유하도록 저장소가
 * 소유한다. `strays`는 세션 id 형태가 아닌 잔재(temp 등)의 절대 경로다.
 */
export async function listPersistedHostCommandSessions(args: {
  stateRoot: string;
  threadId?: string;
}): Promise<{
  sessions: PersistedHostCommandLocation[];
  strays: string[];
}> {
  const sessions: PersistedHostCommandLocation[] = [];
  const strays: string[] = [];
  const threadRoot = join(args.stateRoot, '.geulbat', 'tool-outputs');
  const threadDirectories =
    args.threadId === undefined
      ? await readDirectoryNames(threadRoot)
      : [encodeRefPart(args.threadId)];
  for (const encodedThreadId of threadDirectories) {
    let threadId: string;
    try {
      threadId = decodeURIComponent(encodedThreadId);
    } catch {
      continue;
    }
    const sessionRoot = join(threadRoot, encodedThreadId, 'command-sessions');
    for (const entryName of await readDirectoryNames(sessionRoot)) {
      const outputRef = buildHostCommandOutputRef({
        threadId,
        sessionId: entryName,
      });
      const parsed = parseHostCommandOutputRef(outputRef);
      if (!parsed.ok) {
        strays.push(join(sessionRoot, entryName));
        continue;
      }
      sessions.push({
        outputRef,
        threadId,
        sessionId: entryName,
        paths: buildHostCommandPaths({
          stateRoot: args.stateRoot,
          threadId,
          outputRef,
        }),
      });
    }
  }
  return { sessions, strays };
}

/**
 * P7.5 §5.6 — 보존 집합 밖의 산출물 수거. 보존 집합은 transcript 참조 ∪
 * 워커 active ∪ 데몬 in-flight claimed-ref의 합집합이며, 그 합집합을 만들 수
 * 없을 때 호출자는 이 함수를 아예 부르지 않는다(fail-closed).
 */
export async function collectUnreferencedHostCommandOutputs(args: {
  stateRoot: string;
  threadId: string;
  preservedOutputRefs: ReadonlySet<string>;
}): Promise<number> {
  const { sessions } = await listPersistedHostCommandSessions({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
  });
  let deleted = 0;
  for (const session of sessions) {
    if (args.preservedOutputRefs.has(session.outputRef)) {
      continue;
    }
    if (await hasUnknownArtifactFormat(session.paths)) {
      // §5.4 — 미지 major는 삭제·재구성 없이 격리한다. 해석할 수 없는
      // 산출물을 도달 불가 판정만으로 지우지 않는다.
      continue;
    }
    try {
      await rm(session.paths.directory, { recursive: true, force: false });
      deleted += 1;
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      continue;
    }
    await removeEmptyDirectoryForPrune(dirname(session.paths.directory));
    await removeEmptyDirectoryForPrune(
      dirname(dirname(session.paths.directory)),
    );
  }
  return deleted;
}

async function hasUnknownArtifactFormat(
  paths: HostCommandPaths,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.metadata, 'utf8'));
  } catch {
    // 읽을 수 없는 메타는 major를 주장하지 않는다 — 격리 대상이 아니다.
    return false;
  }
  const major = readHostCommandArtifactFormatVersion(parsed);
  return major !== undefined && major !== HOST_COMMAND_ARTIFACT_FORMAT_VERSION;
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readUtf8OutputPage(args: {
  path: string;
  stream: HostCommandOutputStream;
  offsetBytes: number;
  limitBytes: number;
}): Promise<
  | { ok: true; value: HostCommandOutputPage }
  | {
      ok: false;
      reasonCode: 'invalid_args' | 'output_store_failed';
      message: string;
    }
> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(args.path, 'r');
    const fileStats = await handle.stat();
    const totalBytes = fileStats.size;
    const offsetBytes = Math.min(args.offsetBytes, totalBytes);
    if (offsetBytes < totalBytes) {
      const first = Buffer.allocUnsafe(1);
      await handle.read(first, 0, 1, offsetBytes);
      if ((first[0]! & 0xc0) === 0x80) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message: 'offsetBytes must point to a UTF-8 character boundary.',
        };
      }
    }
    const requestedBytes = Math.min(args.limitBytes, totalBytes - offsetBytes);
    const buffer = Buffer.allocUnsafe(requestedBytes);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      requestedBytes,
      offsetBytes,
    );
    const validBytes = findValidUtf8PrefixLength(buffer.subarray(0, bytesRead));
    if (bytesRead > 0 && validBytes === 0) {
      return {
        ok: false,
        reasonCode: 'invalid_args',
        message: `limitBytes must be at least ${UTF8_MAX_CODE_POINT_BYTES} when more output remains.`,
      };
    }
    const endOffsetBytes = offsetBytes + validBytes;
    const hasMore = endOffsetBytes < totalBytes;
    return {
      ok: true,
      value: {
        stream: args.stream,
        offsetBytes,
        endOffsetBytes,
        totalBytes,
        limitBytes: args.limitBytes,
        hasMore,
        nextOffsetBytes: hasMore ? endOffsetBytes : null,
        content: buffer.subarray(0, validBytes).toString('utf8'),
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reasonCode: 'output_store_failed',
      message: getErrorMessage(error),
    };
  } finally {
    await closeFileHandle(handle);
  }
}

function findValidUtf8PrefixLength(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - (UTF8_MAX_CODE_POINT_BYTES - 1));
  for (let end = buffer.length; end >= minimum; end -= 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      return end;
    } catch {
      continue;
    }
  }
  return 0;
}

function encodeRefPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * §5.4 — 산출물의 저장 포맷 major를 읽는다. `formatVersion`이 정본이고,
 * 그 필드가 생기기 전 산출물은 `schemaVersion`이 같은 자리를 지킨다.
 * 어느 쪽도 숫자가 아니면 major를 알 수 없으므로 undefined다.
 */
export function readHostCommandArtifactFormatVersion(
  value: unknown,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['formatVersion', 'schemaVersion']) {
    const candidate = value[key];
    if (isNonNegativeInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isHostCommandMetadata(
  value: unknown,
  outputRef: string,
  threadId: string,
): value is HostCommandMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return (
    // major가 같으면 모르는 필드가 더 있어도 읽는다 — additive 규율의
    // 실체가 이 관용이다 (§5.4 A안). major를 올리는 미래 빌드는 두 필드를
    // 함께 올린다: `formatVersion`이 이기므로 구 필드만 보는 리더가 새
    // 산출물을 오해할 창이 닫힌다.
    readHostCommandArtifactFormatVersion(value) ===
      HOST_COMMAND_ARTIFACT_FORMAT_VERSION &&
    value['schemaVersion'] === 1 &&
    value['outputRef'] === outputRef &&
    value['threadId'] === threadId &&
    typeof value['runId'] === 'string' &&
    typeof value['callId'] === 'string' &&
    isHostCommandStatus(value['status']) &&
    (value['exitCode'] === null || typeof value['exitCode'] === 'number') &&
    isNonNegativeInteger(value['stdoutBytes']) &&
    isNonNegativeInteger(value['stderrBytes']) &&
    (value['stdoutChars'] === null ||
      isNonNegativeInteger(value['stdoutChars'])) &&
    (value['stderrChars'] === null ||
      isNonNegativeInteger(value['stderrChars'])) &&
    isNonNegativeInteger(value['startedAtMs']) &&
    (value['finishedAtMs'] === null ||
      isNonNegativeInteger(value['finishedAtMs'])) &&
    (value['firstOutputAfterMs'] === null ||
      isNonNegativeInteger(value['firstOutputAfterMs'])) &&
    isNonNegativeInteger(value['revision']) &&
    typeof value['stdinOpen'] === 'boolean' &&
    isOutputLimitExceeded(value['outputLimitExceeded']) &&
    (value['stdoutBaseOffset'] === undefined ||
      isNonNegativeInteger(value['stdoutBaseOffset'])) &&
    (value['stderrBaseOffset'] === undefined ||
      isNonNegativeInteger(value['stderrBaseOffset'])) &&
    (value['terminationReason'] === undefined ||
      typeof value['terminationReason'] === 'string') &&
    (value['finalRevision'] === undefined ||
      isNonNegativeInteger(value['finalRevision'])) &&
    (value['outputPersistFailed'] === undefined ||
      typeof value['outputPersistFailed'] === 'boolean')
  );
}

function isHostCommandStatus(value: unknown): value is HostCommandStatus {
  return (
    value === 'running' ||
    value === 'exit' ||
    value === 'crash' ||
    value === 'timeout' ||
    value === 'cancelled' ||
    value === 'signal' ||
    value === 'output_limit_exceeded' ||
    value === 'output_store_failed' ||
    value === 'daemon_shutdown' ||
    value === 'daemon_restart_interrupted' ||
    value === 'command_host_interrupted'
  );
}

function isOutputLimitExceeded(
  value: unknown,
): value is HostCommandSnapshot['outputLimitExceeded'] {
  return (
    value === null ||
    (isRecord(value) &&
      (value['stream'] === 'stdout' || value['stream'] === 'stderr') &&
      isNonNegativeInteger(value['maxOutputBytesPerStream']))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function closeFileHandle(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Read cleanup must not replace the owning read failure.
  }
}

async function removeEmptyParent(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // A sibling session or a concurrent writer keeps the shared directory.
  }
}

async function removeEmptyDirectoryForPrune(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error;
    }
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error['code'];
  return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'host command output failed';
}
