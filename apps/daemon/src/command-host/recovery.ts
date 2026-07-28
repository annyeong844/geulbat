import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HOST_COMMAND_ARTIFACT_FORMAT_VERSION,
  listPersistedHostCommandSessions,
  readHostCommandArtifactFormatVersion,
  removeHostCommandDirectory,
  type HostCommandMetadata,
  type HostCommandPaths,
  type PersistedHostCommandLocation,
} from '../daemon/host-command-output-store.js';
import { isNotFoundError } from '../daemon/utils/error.js';
import { writeDurableFile } from './durability.js';
import {
  buildCommandHostJournalPath,
  readSpawnJournal,
  type JournalClosedRecord,
  type JournalOpenRecord,
} from './journal.js';
import { verifyProcessBirthToken } from './process-identity.js';

// P7.5 spec v4 §5.2·§5.3·§5.5 — 기동 복구. 순서가 규범이다:
//   1. metadata/artifact reconcile
//   2. terminal 판명 세션의 journal open 엔트리 제거
//   3. 남은 open 중 birthToken 검증 성공분만 pgid 종료 — 실패 시 kill 금지
//   4. running metadata → command_host_interrupted
//   5. claim 메타 없는 디렉터리·temp 잔재 수거
// 1·4는 세션 단위로 함께 판정된다(§5.5 복구 표).

const TEMP_FILE_MARKER = '.tmp-';

interface CommandHostRecoveryReport {
  /** 디스크에서 발견한 세션 수. */
  inspectedSessions: number;
  /** journal closed 행 근거로 finished 승격된 수 (§5.3 3행). */
  promotedToFinished: number;
  /** 링이 유실되어 command_host_interrupted로 수렴한 수. */
  markedInterrupted: number;
  /** claim 메타가 없어 수거한 디렉터리 수. */
  removedIncomplete: number;
  /** 손상·미지 포맷으로 손대지 않고 남긴 수. */
  quarantined: number;
  /** birthToken 검증 후 실제로 종료시킨 프로세스 그룹 수. */
  reapedProcessGroups: number;
  /** 검증 불가로 kill하지 않은 open 엔트리 수. */
  unverifiedOrphans: number;
  removedTempArtifacts: number;
}

export async function recoverCommandHostState(args: {
  stateRoot: string;
}): Promise<CommandHostRecoveryReport> {
  const report: CommandHostRecoveryReport = {
    inspectedSessions: 0,
    promotedToFinished: 0,
    markedInterrupted: 0,
    removedIncomplete: 0,
    quarantined: 0,
    reapedProcessGroups: 0,
    unverifiedOrphans: 0,
    removedTempArtifacts: 0,
  };

  const journalPath = buildCommandHostJournalPath(args.stateRoot);
  const journal = await readSpawnJournal(journalPath);
  if (!journal.ok && journal.reason === 'unknown_format') {
    // §5.4 — 미지 major는 삭제·재구성 없이 격리한다.
    await quarantineJournal(journalPath, journal.journalFormatVersion);
    report.quarantined += 1;
  }
  const closedRows: ReadonlyMap<string, JournalClosedRecord> = journal.ok
    ? journal.closed
    : new Map();
  const openRows: readonly JournalOpenRecord[] = journal.ok ? journal.open : [];

  // 1·4·5 — 세션 단위 reconcile.
  const { sessions, strays } = await listPersistedHostCommandSessions({
    stateRoot: args.stateRoot,
  });
  // 프로세스가 **확실히 끝난** 세션만 담는다. `command_host_interrupted`는
  // 링을 잃었다는 장부상 판정일 뿐 자식이 죽었다는 뜻이 아니므로 여기
  // 들어가면 안 된다 — 스펙이 4단계(interrupted 표시)를 3단계(kill) 뒤에
  // 두는 이유다.
  const endedSessionIds = new Set<string>();
  for (const session of sessions) {
    report.inspectedSessions += 1;
    report.removedTempArtifacts += await removeTempArtifacts(
      session.paths.directory,
    );
    const outcome = await reconcileSession(session, closedRows);
    switch (outcome) {
      case 'promoted':
        report.promotedToFinished += 1;
        endedSessionIds.add(session.sessionId);
        break;
      case 'already_terminal':
        endedSessionIds.add(session.sessionId);
        break;
      case 'interrupted':
        // 링만 잃었다 — 자식은 고아로 살아 있을 수 있으므로 reap 대상이다.
        report.markedInterrupted += 1;
        break;
      case 'removed':
        // claim이 커밋되지 않은 잔재. 자식이 남아 있으면 역시 고아다.
        report.removedIncomplete += 1;
        break;
      case 'quarantined':
        // 산출물은 손대지 않지만(§5.4) 프로세스 수명과는 무관하다.
        report.quarantined += 1;
        break;
    }
  }
  for (const stray of strays) {
    await rm(stray, { recursive: true, force: true }).catch(() => undefined);
    report.removedTempArtifacts += 1;
  }

  // 2·3 — 확실히 끝난 세션을 뺀 나머지 open 엔트리가 reap 대상이다.
  for (const row of openRows) {
    if (endedSessionIds.has(row.sessionId)) {
      continue;
    }
    const verified = await verifyProcessBirthToken(row.pid, row.birthToken);
    if (!verified) {
      // pid 재사용을 구분할 수 없으면 남의 프로세스를 죽일 수 있다 (§5.2).
      report.unverifiedOrphans += 1;
      continue;
    }
    if (killProcessGroup(row.pgid)) {
      report.reapedProcessGroups += 1;
    }
  }

  // 이전 세대의 open 행은 이 패스에서 정확히 한 번 처리됐다 — 저널 잔재를
  // 0으로 만든다 (§14 수용기준 5).
  if (journal.ok && openRows.length > 0) {
    await rm(journalPath, { force: true }).catch(() => undefined);
  }

  return report;
}

type SessionRecoveryOutcome =
  | 'promoted'
  | 'interrupted'
  | 'already_terminal'
  | 'removed'
  | 'quarantined';

async function reconcileSession(
  session: PersistedHostCommandLocation,
  closedRows: ReadonlyMap<string, JournalClosedRecord>,
): Promise<SessionRecoveryOutcome> {
  let raw: string;
  try {
    raw = await readFile(session.paths.metadata, 'utf8');
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    // claim 메타가 없는 디렉터리 = 커밋되지 않은 잔재 (§5.2 5단계).
    await removeHostCommandDirectory(session.paths.directory);
    return 'removed';
  }
  let metadata: HostCommandMetadata;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecoverableMetadata(parsed)) {
      return 'quarantined';
    }
    metadata = parsed;
  } catch {
    return 'quarantined';
  }
  if (metadata.status !== 'running') {
    return 'already_terminal';
  }

  const closed = closedRows.get(session.sessionId);
  if (
    closed?.terminal !== undefined &&
    closed.terminal.outputPersistFailed !== true &&
    (await hasCompleteArtifacts(session.paths))
  ) {
    // §5.3 3행 — artifact는 자기서술적이지 않으므로 journal closed 행이
    // terminal 진실의 원천이다.
    await writeMetadata(session.paths, {
      ...metadata,
      status: toHostCommandStatus(closed.terminal.status),
      exitCode: closed.terminal.exitCode,
      stdoutBytes: closed.terminal.stdoutBytes,
      stderrBytes: closed.terminal.stderrBytes,
      stdoutChars: closed.terminal.stdoutChars,
      stderrChars: closed.terminal.stderrChars,
      stdoutBaseOffset: closed.terminal.stdoutBaseOffset,
      stderrBaseOffset: closed.terminal.stderrBaseOffset,
      finishedAtMs: closed.terminal.finishedAtMs,
      finalRevision: closed.terminal.finalRevision,
      revision: closed.terminal.finalRevision,
      stdinOpen: false,
      ...(closed.terminal.terminationReason === undefined
        ? {}
        : { terminationReason: closed.terminal.terminationReason }),
    });
    return 'promoted';
  }

  // 링이 워커와 함께 사라졌다 (§5.5 2행 · §8.2).
  await writeMetadata(session.paths, {
    ...metadata,
    status: 'command_host_interrupted',
    terminationReason: 'command_host_lost',
    exitCode: null,
    finishedAtMs: Date.now(),
    stdinOpen: false,
    revision: metadata.revision + 1,
  });
  return 'interrupted';
}

async function writeMetadata(
  paths: HostCommandPaths,
  metadata: HostCommandMetadata,
): Promise<void> {
  await writeDurableFile(
    paths.metadata,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

async function hasCompleteArtifacts(paths: HostCommandPaths): Promise<boolean> {
  for (const path of [paths.stdout, paths.stderr]) {
    try {
      await readFile(path);
    } catch {
      return false;
    }
  }
  return true;
}

async function removeTempArtifacts(directory: string): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.includes(TEMP_FILE_MARKER)) {
      continue;
    }
    await rm(join(directory, name), { recursive: true, force: true }).catch(
      () => undefined,
    );
    removed += 1;
  }
  return removed;
}

async function quarantineJournal(
  path: string,
  journalFormatVersion: number,
): Promise<void> {
  await rename(path, `${path}.unreadable-v${journalFormatVersion}`).catch(
    () => undefined,
  );
}

function killProcessGroup(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    return false;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function toHostCommandStatus(status: string): HostCommandMetadata['status'] {
  // 저널 행은 문자열이지만 승격 대상은 종료 상태뿐이다 — 알 수 없는 값은
  // 종료했다는 사실만 남기고 보수적으로 crash로 수렴시킨다.
  switch (status) {
    case 'exit':
    case 'crash':
    case 'timeout':
    case 'cancelled':
    case 'signal':
    case 'output_limit_exceeded':
    case 'output_store_failed':
    case 'daemon_shutdown':
    case 'command_host_interrupted':
      return status;
    default:
      return 'crash';
  }
}

function isRecoverableMetadata(value: unknown): value is HostCommandMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    // §5.4 — 저장소와 같은 major 판정을 쓴다. 미지 major는 재구성하지
    // 않고 격리한다(호출자가 quarantined로 센다).
    readHostCommandArtifactFormatVersion(value) ===
      HOST_COMMAND_ARTIFACT_FORMAT_VERSION &&
    typeof record['outputRef'] === 'string' &&
    typeof record['status'] === 'string' &&
    typeof record['revision'] === 'number'
  );
}
