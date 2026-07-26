import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { syncDirectory } from './durability.js';

// P7.5 spec v4 §5.1 — spawn journal. "journal에 없는 자식은 존재할 수 없다"를
// 성립시키는 유일한 장치이므로 모든 append·fdatasync·compaction은 단일 FIFO
// writer로 직렬화하고, compaction rename 후 append fd를 다시 연다(T23).
//
// closed 행은 terminal 기술자를 함께 나른다 — tail 산출물은 자기서술적이지
// 않으므로 §5.3 3행(artifact 성공 + terminal metadata 실패)의 재시작 승격은
// 이 행만이 근거가 된다.

const JOURNAL_FORMAT_VERSION = 1;

// 유계성의 존재가 규범이고 값은 튜닝 기본값이다 (§5.1: 행당 ~150B로
// 1MiB ≈ 7천 레코드).
const JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_MIN_CLOSED_RECORDS = 256;
const JOURNAL_CLOSED_TO_OPEN_RATIO = 4;

export function buildCommandHostJournalPath(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'command-host', 'journal.jsonl');
}

const terminalDescriptorSchema = z.object({
  status: z.string(),
  exitCode: z.number().nullable(),
  terminationReason: z.string().optional(),
  finalRevision: z.number(),
  stdoutBaseOffset: z.number(),
  stderrBaseOffset: z.number(),
  stdoutBytes: z.number(),
  stderrBytes: z.number(),
  stdoutChars: z.number().nullable(),
  stderrChars: z.number().nullable(),
  finishedAtMs: z.number(),
  /** artifact 기록 실패 — 이 행으로 finished 승격을 하면 안 된다(§5.3 4행). */
  outputPersistFailed: z.literal(true).optional(),
});

const headerRecordSchema = z.object({
  kind: z.literal('header'),
  journalFormatVersion: z.number(),
  workerInstanceId: z.string(),
});

const openRecordSchema = z.object({
  kind: z.literal('open'),
  seq: z.number(),
  sessionId: z.string(),
  outputRef: z.string(),
  threadId: z.string(),
  pid: z.number(),
  pgid: z.number(),
  /** 검증 불가 플랫폼은 null — reap은 그런 세션을 kill하지 않는다(§5.2). */
  birthToken: z.string().nullable(),
  /** fd3 실행 게이트 적용 여부. false는 명시 강등이다(§5.1). */
  gated: z.boolean(),
});

const closedRecordSchema = z.object({
  kind: z.literal('closed'),
  seq: z.number(),
  sessionId: z.string(),
  phase: z.union([z.literal('finished'), z.literal('discarded')]),
  terminal: terminalDescriptorSchema.optional(),
  /**
   * terminal metadata 기록이 실패한 행 — compaction이 지워서는 안 된다.
   * 이 행이 사라지면 §5.3 3행의 승격 근거가 사라진다.
   */
  terminalMetaDirty: z.literal(true).optional(),
});

export type JournalTerminalDescriptor = z.infer<
  typeof terminalDescriptorSchema
>;
export type JournalOpenRecord = z.infer<typeof openRecordSchema>;
export type JournalClosedRecord = z.infer<typeof closedRecordSchema>;
type JournalHeaderRecord = z.infer<typeof headerRecordSchema>;
type JournalRecord =
  | JournalHeaderRecord
  | JournalOpenRecord
  | JournalClosedRecord;

export interface SpawnJournal {
  /**
   * open 행을 기록하고 fdatasync가 성공한 뒤에 resolve한다. 호출자는 이
   * resolve 이후에만 실행 게이트에 GO를 써야 한다 (§5.1).
   */
  appendOpen(record: Omit<JournalOpenRecord, 'kind' | 'seq'>): Promise<void>;
  appendClosed(
    record: Omit<JournalClosedRecord, 'kind' | 'seq'>,
  ): Promise<void>;
  /** §6.3 pendingCriticalIoCount — 큐에 있거나 진행 중인 append 수. */
  pendingCriticalIo(): number;
  stats(): { bytes: number; openRecords: number; closedRecords: number };
  close(): Promise<void>;
}

type SpawnJournalContents =
  | {
      ok: true;
      workerInstanceId: string | null;
      /** 아직 닫히지 않은 open 행 (기록 순서). */
      open: JournalOpenRecord[];
      /** sessionId → 마지막 closed 행. */
      closed: Map<string, JournalClosedRecord>;
      bytes: number;
      maxSeq: number;
    }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'unknown_format'; journalFormatVersion: number };

export async function readSpawnJournal(
  path: string,
): Promise<SpawnJournalContents> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const open = new Map<string, JournalOpenRecord>();
  const closed = new Map<string, JournalClosedRecord>();
  let workerInstanceId: string | null = null;
  let maxSeq = 0;
  for (const line of raw.split('\n')) {
    const record = parseJournalLine(line);
    if (record === undefined) {
      // 크래시로 잘린 마지막 행 등 — 해석 불가 행은 없는 것으로 본다.
      continue;
    }
    if (record.kind === 'header') {
      if (record.journalFormatVersion !== JOURNAL_FORMAT_VERSION) {
        return {
          ok: false,
          reason: 'unknown_format',
          journalFormatVersion: record.journalFormatVersion,
        };
      }
      workerInstanceId = record.workerInstanceId;
      continue;
    }
    maxSeq = Math.max(maxSeq, record.seq);
    if (record.kind === 'open') {
      open.set(record.sessionId, record);
      continue;
    }
    open.delete(record.sessionId);
    closed.set(record.sessionId, record);
  }
  return {
    ok: true,
    workerInstanceId,
    open: [...open.values()],
    closed,
    bytes: Buffer.byteLength(raw),
    maxSeq,
  };
}

export async function openSpawnJournal(args: {
  path: string;
  workerInstanceId: string;
}): Promise<SpawnJournal> {
  await mkdir(dirname(args.path), { recursive: true, mode: 0o700 });
  const existing = await readSpawnJournal(args.path);
  if (!existing.ok && existing.reason === 'unknown_format') {
    // 미지 major는 삭제·재구성 없이 격리한다 (§5.4). 격리는 기동 복구의
    // 몫이므로 여기서는 append를 거부한다.
    throw new Error(
      `command-host journal format ${existing.journalFormatVersion} is not readable by this build.`,
    );
  }

  const openRecords = new Map<string, JournalOpenRecord>();
  const dirtyClosed = new Map<string, JournalClosedRecord>();
  let bytes = 0;
  let closedRecords = 0;
  let seq = 0;
  if (existing.ok) {
    for (const record of existing.open) {
      openRecords.set(record.sessionId, record);
    }
    for (const [sessionId, record] of existing.closed) {
      closedRecords += 1;
      if (record.terminalMetaDirty === true) {
        dirtyClosed.set(sessionId, record);
      }
    }
    bytes = existing.bytes;
    seq = existing.maxSeq;
  }

  let handle: FileHandle = await open(args.path, 'a', 0o600);
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let shuttingDown = false;

  if (!existing.ok) {
    await writeLine({
      kind: 'header',
      journalFormatVersion: JOURNAL_FORMAT_VERSION,
      workerInstanceId: args.workerInstanceId,
    });
    await handle.datasync();
  }

  async function writeLine(record: JournalRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await handle.write(line);
    bytes += Buffer.byteLength(line);
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    pending += 1;
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      pending -= 1;
    });
  }

  async function commit(record: JournalOpenRecord | JournalClosedRecord) {
    await writeLine(record);
    await handle.datasync();
    if (record.kind === 'open') {
      openRecords.set(record.sessionId, record);
    } else {
      openRecords.delete(record.sessionId);
      closedRecords += 1;
      if (record.terminalMetaDirty === true) {
        dirtyClosed.set(record.sessionId, record);
      }
    }
    await compactIfNeeded();
  }

  async function compactIfNeeded(): Promise<void> {
    const closedBudget = Math.max(
      JOURNAL_MIN_CLOSED_RECORDS,
      openRecords.size * JOURNAL_CLOSED_TO_OPEN_RATIO,
    );
    if (bytes <= JOURNAL_MAX_BYTES && closedRecords <= closedBudget) {
      return;
    }
    const retained: JournalRecord[] = [
      {
        kind: 'header',
        journalFormatVersion: JOURNAL_FORMAT_VERSION,
        workerInstanceId: args.workerInstanceId,
      },
      ...openRecords.values(),
      ...dirtyClosed.values(),
    ];
    const body = `${retained.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const tempPath = `${args.path}.tmp-${randomUUID()}`;
    let tempHandle: FileHandle | undefined;
    try {
      tempHandle = await open(tempPath, 'wx', 0o600);
      await tempHandle.writeFile(body);
      await tempHandle.sync();
    } finally {
      await tempHandle?.close().catch(() => undefined);
    }
    await rename(tempPath, args.path);
    await syncDirectory(dirname(args.path));
    // T23 — rename된 이후의 append는 새 inode로 가야 한다.
    const previous = handle;
    handle = await open(args.path, 'a', 0o600);
    await previous.close().catch(() => undefined);
    bytes = Buffer.byteLength(body);
    closedRecords = dirtyClosed.size;
  }

  return {
    async appendOpen(record) {
      if (shuttingDown) {
        throw new Error('command-host journal is closed.');
      }
      seq += 1;
      await enqueue(async () => {
        await commit({ kind: 'open', seq, ...record });
      });
    },
    async appendClosed(record) {
      if (shuttingDown) {
        return;
      }
      seq += 1;
      await enqueue(async () => {
        await commit({ kind: 'closed', seq, ...record });
      });
    },
    pendingCriticalIo() {
      return pending;
    },
    stats() {
      return {
        bytes,
        openRecords: openRecords.size,
        closedRecords,
      };
    },
    async close() {
      shuttingDown = true;
      await chain.catch(() => undefined);
      await handle.close().catch(() => undefined);
    },
  };
}

function parseJournalLine(line: string): JournalRecord | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const header = headerRecordSchema.safeParse(parsed);
  if (header.success) {
    return header.data;
  }
  const openRecord = openRecordSchema.safeParse(parsed);
  if (openRecord.success) {
    return openRecord.data;
  }
  const closedRecord = closedRecordSchema.safeParse(parsed);
  return closedRecord.success ? closedRecord.data : undefined;
}
