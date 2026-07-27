import {
  buildHostCommandPaths,
  HOST_COMMAND_ARTIFACT_FORMAT_VERSION,
  type HostCommandMetadata,
  type HostCommandSnapshot,
} from '../daemon/host-command-output-store.js';
import type { CommandSessionListEntry } from './contract.js';
import type { JournalTerminalDescriptor } from './journal.js';
import type { SessionEntry } from './session-core.js';

// 세션 상태(SessionEntry)를 계약 응답 형태로 옮기는 순수 변환들. 공유 상태를
// 건드리지 않는다 — inline 적격성만 세션 코어가 config로 판정하므로 술어로 받는다.

export function describeSession(entry: SessionEntry): CommandSessionListEntry {
  return {
    outputRef: entry.outputRef,
    threadId: entry.threadId,
    stateRoot: entry.stateRoot,
    runId: entry.runId,
    callId: entry.callId,
    running: entry.terminal === null,
    revision: entry.revision,
    command: entry.command,
    status: entry.terminal?.status ?? 'running',
    startedAtMs: entry.startedAtMs,
    stdoutBytes: entry.stdout.ring.totalBytes,
    stderrBytes: entry.stderr.ring.totalBytes,
    stdinOpen: entry.terminal === null && entry.stdinOpen,
  };
}

export function sessionPaths(entry: SessionEntry) {
  return buildHostCommandPaths({
    stateRoot: entry.stateRoot,
    outputRef: entry.outputRef,
    threadId: entry.threadId,
  });
}

export function buildSnapshot(
  entry: SessionEntry,
  isInlineEligible: (entry: SessionEntry) => boolean,
  options: { includeInline: boolean; outputRef: string | null },
): HostCommandSnapshot {
  const terminal = entry.terminal;
  const eligible = isInlineEligible(entry);
  const inline = options.includeInline && eligible;
  return {
    outputRef: options.outputRef,
    status: terminal?.status ?? 'running',
    exitCode: terminal?.exitCode ?? null,
    stdout: inline ? entry.stdout.ring.snapshot().toString('utf8') : null,
    stderr: inline ? entry.stderr.ring.snapshot().toString('utf8') : null,
    outputComplete: terminal !== null && inline,
    stdoutBytes: entry.stdout.ring.totalBytes,
    stderrBytes: entry.stderr.ring.totalBytes,
    stdoutChars: entry.stdout.chars,
    stderrChars: entry.stderr.chars,
    durationMs: (terminal?.finishedAtMs ?? Date.now()) - entry.startedAtMs,
    firstOutputAfterMs: entry.firstOutputAfterMs,
    revision: entry.revision,
    stdinOpen: entry.stdinOpen,
    outputLimitExceeded: terminal?.outputLimitExceeded ?? null,
    stdoutOmittedBytes: entry.stdout.ring.omittedBytes,
    stderrOmittedBytes: entry.stderr.ring.omittedBytes,
    ...(terminal?.terminationReason === undefined
      ? {}
      : { terminationReason: terminal.terminationReason }),
    ...(entry.outputPersistFailed ? { outputPersistFailed: true } : {}),
    // terminal이 있으면 `status`가 이미 그 사실을 나른다. 아직 정착하지
    // 않았는데 프로세스가 사라진 경우만 따로 알린다.
    ...(terminal === null && entry.processExit !== null
      ? {
          processExit: {
            status: entry.processExit.status,
            exitCode: entry.processExit.exitCode,
          },
        }
      : {}),
  };
}

export function metadataFromEntry(entry: SessionEntry): HostCommandMetadata {
  return {
    // §5.4 — formatVersion이 정본 major다. schemaVersion은 이 필드가
    // 생기기 전 리더를 위해 같은 값으로 함께 남긴다.
    formatVersion: HOST_COMMAND_ARTIFACT_FORMAT_VERSION,
    schemaVersion: 1,
    sessionId: entry.sessionId,
    outputRef: entry.outputRef,
    threadId: entry.threadId,
    runId: entry.runId,
    callId: entry.callId,
    status: entry.terminal?.status ?? 'running',
    exitCode: entry.terminal?.exitCode ?? null,
    stdoutBytes: entry.stdout.ring.totalBytes,
    stderrBytes: entry.stderr.ring.totalBytes,
    stdoutChars: entry.stdout.chars,
    stderrChars: entry.stderr.chars,
    startedAtMs: entry.startedAtMs,
    finishedAtMs: entry.terminal?.finishedAtMs ?? null,
    firstOutputAfterMs: entry.firstOutputAfterMs,
    revision: entry.revision,
    stdinOpen: entry.terminal === null && entry.stdinOpen,
    outputLimitExceeded: entry.terminal?.outputLimitExceeded ?? null,
  };
}

/** §5.1 closed 행이 나르는 terminal 기술자 — 재시작 승격의 근거다. */
export function terminalDescriptorFromEntry(
  entry: SessionEntry,
): JournalTerminalDescriptor {
  const terminal = entry.terminal;
  return {
    status: terminal?.status ?? 'command_host_interrupted',
    exitCode: terminal?.exitCode ?? null,
    ...(terminal?.terminationReason === undefined
      ? {}
      : { terminationReason: terminal.terminationReason }),
    finalRevision: entry.revision,
    stdoutBaseOffset: entry.stdout.ring.omittedBytes,
    stderrBaseOffset: entry.stderr.ring.omittedBytes,
    stdoutBytes: entry.stdout.ring.totalBytes,
    stderrBytes: entry.stderr.ring.totalBytes,
    stdoutChars: entry.stdout.chars,
    stderrChars: entry.stderr.chars,
    finishedAtMs: terminal?.finishedAtMs ?? Date.now(),
    ...(entry.outputPersistFailed ? { outputPersistFailed: true } : {}),
  };
}

export function terminalMetadataFromEntry(
  entry: SessionEntry,
): HostCommandMetadata {
  return {
    ...metadataFromEntry(entry),
    stdoutBaseOffset: entry.stdout.ring.omittedBytes,
    stderrBaseOffset: entry.stderr.ring.omittedBytes,
    finalRevision: entry.revision,
    ...(entry.terminal?.terminationReason === undefined
      ? {}
      : { terminationReason: entry.terminal.terminationReason }),
  };
}
