import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  AgentLoopImplementation,
  AgentLoopImplementationIdentity,
  AgentLoopKernelEvent,
  AgentLoopKernelInput,
} from '@geulbat/agent-loop/kernel';
import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

import {
  parseHarnessConfigSnapshot,
  serializeHarnessConfigSnapshot,
  type HarnessConfigSnapshot,
} from './harness-snapshot.js';
import {
  createHarnessRunTrace,
  parseHarnessRunTrace,
  parseHarnessRunTraceEvent,
  serializeHarnessRunTrace,
  type HarnessRunTrace,
} from './run-trace.js';

export interface XHarnessRunStoreTraceIdentity {
  readonly taskId: string;
  readonly attemptId: string;
  readonly modelConfigId: string;
}

export interface XHarnessRunStoreAdmissionInput {
  readonly harnessSnapshot: HarnessConfigSnapshot;
  readonly traceIdentity: XHarnessRunStoreTraceIdentity;
  readonly evidenceReferenceId?: string;
  readonly implementation: AgentLoopImplementation;
}

export interface XHarnessStoredRunAdmission {
  readonly schemaVersion: 1 | 2;
  readonly attemptKeyHash: string;
  readonly admissionDigest: string;
  readonly harnessSnapshot: HarnessConfigSnapshot;
  readonly traceIdentity: XHarnessRunStoreTraceIdentity;
  readonly loopImplementation: AgentLoopImplementationIdentity;
  readonly evidenceReferenceId: string | null;
}

export interface XHarnessStoredRunTrace {
  readonly schemaVersion: 1;
  readonly attemptKeyHash: string;
  readonly admissionDigest: string;
  readonly trace: HarnessRunTrace;
}

export type XHarnessStoredRunAttemptState =
  | 'admitted'
  | 'execution_claimed'
  | 'terminal';

export interface XHarnessStoredRunAttempt {
  readonly state: XHarnessStoredRunAttemptState;
  readonly admission: XHarnessStoredRunAdmission;
  readonly events: readonly AgentLoopKernelEvent[];
  readonly trace?: XHarnessStoredRunTrace;
}

export interface XHarnessRunAdmission extends Omit<
  XHarnessRunStoreAdmissionInput,
  'implementation'
> {
  readonly implementation: AgentLoopImplementation;
}

export interface XHarnessRunReader {
  listAttemptAdmissions(): Promise<readonly XHarnessStoredRunAdmission[]>;
  readAttemptByReference(
    attemptKeyHash: string,
  ): Promise<XHarnessStoredRunAttempt | undefined>;
}

export interface XHarnessRunStore extends XHarnessRunReader {
  admitRun(
    attemptKey: string,
    input: XHarnessRunStoreAdmissionInput,
  ): Promise<XHarnessRunAdmission>;
  readAdmission(
    attemptKey: string,
  ): Promise<XHarnessStoredRunAdmission | undefined>;
  readJournal(attemptKey: string): Promise<readonly AgentLoopKernelEvent[]>;
  publishTerminalTrace(attemptKey: string): Promise<XHarnessStoredRunTrace>;
  readTrace(attemptKey: string): Promise<XHarnessStoredRunTrace | undefined>;
}

interface StoredExecutionClaim {
  readonly schemaVersion: 1;
  readonly attemptKeyHash: string;
  readonly admissionDigest: string;
}

interface StoredJournalEventPayload {
  readonly schemaVersion: 1;
  readonly attemptKeyHash: string;
  readonly admissionDigest: string;
  readonly eventIndex: number;
  readonly previousEventDigest: string | null;
  readonly event: AgentLoopKernelEvent;
}

interface StoredJournalEvent extends StoredJournalEventPayload {
  readonly eventDigest: string;
}

interface RunRecordPaths {
  readonly attemptDirectory: string;
  readonly admission: string;
  readonly execution: string;
  readonly trace: string;
  readonly eventsDirectory: string;
  readonly pendingDirectory: string;
}

type JsonRecord = Record<string, unknown>;

function assertRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function assertOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return value;
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a sha256 hex digest`);
  }
  return value;
}

function assertEvidenceReferenceId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(
      'xHarness evidenceReferenceId must be a sha256 content reference',
    );
  }
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function hashAttemptKey(attemptKey: string): string {
  return sha256StableJson({
    schemaVersion: 1,
    attemptKey: assertOpaqueId(attemptKey, 'xHarness attempt key'),
  });
}

function canonicalizeAdmissionInput(
  input: XHarnessRunStoreAdmissionInput,
): XHarnessRunStoreAdmissionInput {
  const harnessSnapshot = parseHarnessConfigSnapshot(
    serializeHarnessConfigSnapshot(input.harnessSnapshot),
  );
  const traceIdentity = Object.freeze({
    taskId: assertOpaqueId(input.traceIdentity.taskId, 'taskId'),
    attemptId: assertOpaqueId(input.traceIdentity.attemptId, 'attemptId'),
    modelConfigId: assertOpaqueId(
      input.traceIdentity.modelConfigId,
      'modelConfigId',
    ),
  });
  const implementation = Object.freeze({
    implementationId: assertOpaqueId(
      input.implementation.implementationId,
      'implementationId',
    ),
    contractVersion: assertOpaqueId(
      input.implementation.contractVersion,
      'contractVersion',
    ),
    run<
      TResult extends { ok: boolean },
      TFunctionCall,
      TStructuredOutput,
      THistoryItem,
    >(
      runInput: AgentLoopKernelInput<
        TResult,
        TFunctionCall,
        TStructuredOutput,
        THistoryItem
      >,
    ): Promise<TResult> {
      return input.implementation.run(runInput);
    },
  }) satisfies AgentLoopImplementation;
  const evidenceReferenceId =
    input.evidenceReferenceId === undefined
      ? undefined
      : assertEvidenceReferenceId(input.evidenceReferenceId);
  return Object.freeze({
    harnessSnapshot,
    traceIdentity,
    ...(evidenceReferenceId === undefined ? {} : { evidenceReferenceId }),
    implementation,
  });
}

function createStoredAdmission(
  attemptKeyHash: string,
  input: XHarnessRunStoreAdmissionInput,
): XHarnessStoredRunAdmission {
  const payload = {
    schemaVersion: 2 as const,
    attemptKeyHash,
    harnessSnapshot: input.harnessSnapshot,
    traceIdentity: input.traceIdentity,
    loopImplementation: {
      implementationId: input.implementation.implementationId,
      contractVersion: input.implementation.contractVersion,
    },
    evidenceReferenceId: input.evidenceReferenceId ?? null,
  };
  return Object.freeze({
    ...payload,
    admissionDigest: sha256StableJson(payload),
  });
}

function parseStoredAdmission(value: unknown): XHarnessStoredRunAdmission {
  const record = assertRecord(value, 'xHarness admission record');
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new Error('unsupported xHarness admission schemaVersion');
  }
  assertExactKeys(
    record,
    record.schemaVersion === 1
      ? [
          'schemaVersion',
          'attemptKeyHash',
          'admissionDigest',
          'harnessSnapshot',
          'traceIdentity',
          'loopImplementation',
        ]
      : [
          'schemaVersion',
          'attemptKeyHash',
          'admissionDigest',
          'harnessSnapshot',
          'traceIdentity',
          'loopImplementation',
          'evidenceReferenceId',
        ],
    'xHarness admission record',
  );
  const schemaVersion: 1 | 2 = record.schemaVersion;
  const attemptKeyHash = assertDigest(record.attemptKeyHash, 'attemptKeyHash');
  const admissionDigest = assertDigest(
    record.admissionDigest,
    'admissionDigest',
  );
  const traceIdentityRecord = assertRecord(
    record.traceIdentity,
    'traceIdentity',
  );
  assertExactKeys(
    traceIdentityRecord,
    ['taskId', 'attemptId', 'modelConfigId'],
    'traceIdentity',
  );
  const loopImplementationRecord = assertRecord(
    record.loopImplementation,
    'loopImplementation',
  );
  assertExactKeys(
    loopImplementationRecord,
    ['implementationId', 'contractVersion'],
    'loopImplementation',
  );
  const harnessSnapshot = parseHarnessConfigSnapshot(
    stableStringify(record.harnessSnapshot),
  );
  const traceIdentity = Object.freeze({
    taskId: assertOpaqueId(traceIdentityRecord.taskId, 'taskId'),
    attemptId: assertOpaqueId(traceIdentityRecord.attemptId, 'attemptId'),
    modelConfigId: assertOpaqueId(
      traceIdentityRecord.modelConfigId,
      'modelConfigId',
    ),
  });
  const loopImplementation = Object.freeze({
    implementationId: assertOpaqueId(
      loopImplementationRecord.implementationId,
      'implementationId',
    ),
    contractVersion: assertOpaqueId(
      loopImplementationRecord.contractVersion,
      'contractVersion',
    ),
  });
  const evidenceReferenceId =
    schemaVersion === 1 || record.evidenceReferenceId === null
      ? null
      : assertEvidenceReferenceId(record.evidenceReferenceId);
  const payload =
    schemaVersion === 1
      ? {
          schemaVersion,
          attemptKeyHash,
          harnessSnapshot,
          traceIdentity,
          loopImplementation,
        }
      : {
          schemaVersion,
          attemptKeyHash,
          harnessSnapshot,
          traceIdentity,
          loopImplementation,
          evidenceReferenceId,
        };
  if (sha256StableJson(payload) !== admissionDigest) {
    throw new Error('xHarness admission digest does not match its body');
  }
  return Object.freeze({
    ...payload,
    admissionDigest,
    evidenceReferenceId,
  });
}

function parseStoredExecutionClaim(value: unknown): StoredExecutionClaim {
  const record = assertRecord(value, 'xHarness execution claim');
  assertExactKeys(
    record,
    ['schemaVersion', 'attemptKeyHash', 'admissionDigest'],
    'xHarness execution claim',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported xHarness execution claim schemaVersion');
  }
  return Object.freeze({
    schemaVersion: 1,
    attemptKeyHash: assertDigest(record.attemptKeyHash, 'attemptKeyHash'),
    admissionDigest: assertDigest(record.admissionDigest, 'admissionDigest'),
  });
}

function createStoredJournalEvent(
  admission: XHarnessStoredRunAdmission,
  eventIndex: number,
  previousEventDigest: string | null,
  event: AgentLoopKernelEvent,
): StoredJournalEvent {
  const payload: StoredJournalEventPayload = {
    schemaVersion: 1,
    attemptKeyHash: admission.attemptKeyHash,
    admissionDigest: admission.admissionDigest,
    eventIndex,
    previousEventDigest,
    event: parseHarnessRunTraceEvent(event, eventIndex),
  };
  return Object.freeze({
    ...payload,
    eventDigest: sha256StableJson(payload),
  });
}

function parseStoredJournalEvent(value: unknown): StoredJournalEvent {
  const record = assertRecord(value, 'xHarness journal record');
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'attemptKeyHash',
      'admissionDigest',
      'eventIndex',
      'previousEventDigest',
      'event',
      'eventDigest',
    ],
    'xHarness journal record',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported xHarness journal schemaVersion');
  }
  if (
    typeof record.eventIndex !== 'number' ||
    !Number.isSafeInteger(record.eventIndex) ||
    record.eventIndex < 0
  ) {
    throw new Error('xHarness journal eventIndex is invalid');
  }
  const previousEventDigest =
    record.previousEventDigest === null
      ? null
      : assertDigest(record.previousEventDigest, 'previousEventDigest');
  const payload: StoredJournalEventPayload = {
    schemaVersion: 1,
    attemptKeyHash: assertDigest(record.attemptKeyHash, 'attemptKeyHash'),
    admissionDigest: assertDigest(record.admissionDigest, 'admissionDigest'),
    eventIndex: record.eventIndex,
    previousEventDigest,
    event: parseHarnessRunTraceEvent(record.event, record.eventIndex),
  };
  const eventDigest = assertDigest(record.eventDigest, 'eventDigest');
  if (sha256StableJson(payload) !== eventDigest) {
    throw new Error('xHarness journal digest does not match its body');
  }
  return Object.freeze({ ...payload, eventDigest });
}

function parseStoredTrace(value: unknown): XHarnessStoredRunTrace {
  const record = assertRecord(value, 'xHarness stored trace');
  assertExactKeys(
    record,
    ['schemaVersion', 'attemptKeyHash', 'admissionDigest', 'trace'],
    'xHarness stored trace',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported xHarness stored trace schemaVersion');
  }
  return Object.freeze({
    schemaVersion: 1,
    attemptKeyHash: assertDigest(record.attemptKeyHash, 'attemptKeyHash'),
    admissionDigest: assertDigest(record.admissionDigest, 'admissionDigest'),
    trace: parseHarnessRunTrace(stableStringify(record.trace)),
  });
}

async function readJson(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error('xHarness run record contains invalid JSON', {
      cause: error,
    });
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function publishImmutableJson(args: {
  path: string;
  value: unknown;
  pendingDirectory: string;
  allowIdenticalExisting: boolean;
  conflictMessage: string;
}): Promise<void> {
  const bytes = Buffer.from(`${stableStringify(args.value)}\n`, 'utf8');
  await mkdir(dirname(args.path), { recursive: true });
  await mkdir(args.pendingDirectory, { recursive: true });
  const temporaryPath = join(args.pendingDirectory, `${randomUUID()}.pending`);

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, args.path);
    } catch (error: unknown) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
      if (!args.allowIdenticalExisting) {
        throw new Error(args.conflictMessage);
      }
      const existingBytes = await readFile(args.path);
      if (!existingBytes.equals(bytes)) {
        throw new Error(args.conflictMessage);
      }
    }
  } finally {
    await removeTemporaryFile(temporaryPath);
  }
}

function createRecordPaths(
  root: string,
  attemptKeyHash: string,
): RunRecordPaths {
  const attemptDirectory = join(root, 'attempts', attemptKeyHash);
  return {
    attemptDirectory,
    admission: join(attemptDirectory, 'admission.json'),
    execution: join(attemptDirectory, 'execution.json'),
    trace: join(attemptDirectory, 'trace.json'),
    eventsDirectory: join(attemptDirectory, 'events'),
    pendingDirectory: join(attemptDirectory, '.pending'),
  };
}

function parseEventFileName(name: string): number | undefined {
  const match = /^(0|[1-9]\d*)\.json$/u.exec(name);
  if (match === null) {
    return undefined;
  }
  const eventIndex = Number(match[1]);
  return Number.isSafeInteger(eventIndex) ? eventIndex : undefined;
}

async function assertNoPublishedAttemptWithoutAdmission(
  paths: RunRecordPaths,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(paths.attemptDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name !== '.pending' || !entry.isDirectory()) {
      throw new Error('xHarness attempt has durable data without an admission');
    }
  }
}

async function readStoredAdmissionByReference(
  paths: RunRecordPaths,
  attemptKeyHash: string,
): Promise<XHarnessStoredRunAdmission | undefined> {
  const value = await readJson(paths.admission);
  if (value === undefined) {
    await assertNoPublishedAttemptWithoutAdmission(paths);
    return undefined;
  }
  const admission = parseStoredAdmission(value);
  if (admission.attemptKeyHash !== attemptKeyHash) {
    throw new Error('xHarness admission belongs to another attempt reference');
  }
  return admission;
}

async function listStoredAttemptAdmissions(
  root: string,
): Promise<readonly XHarnessStoredRunAdmission[]> {
  let entries;
  try {
    entries = await readdir(join(root, 'attempts'), { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return Object.freeze([]);
    }
    throw error;
  }

  const admissions: XHarnessStoredRunAdmission[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error('xHarness attempts root contains a non-directory entry');
    }
    const attemptKeyHash = assertDigest(
      entry.name,
      'xHarness attempt reference',
    );
    const paths = createRecordPaths(root, attemptKeyHash);
    const admission = await readStoredAdmissionByReference(
      paths,
      attemptKeyHash,
    );
    if (admission !== undefined) {
      admissions.push(admission);
    }
  }
  admissions.sort((left, right) =>
    left.attemptKeyHash.localeCompare(right.attemptKeyHash),
  );
  return Object.freeze(admissions);
}

async function requireStoredAdmission(
  paths: RunRecordPaths,
  attemptKeyHash: string,
): Promise<XHarnessStoredRunAdmission> {
  const admission = await readStoredAdmissionByReference(paths, attemptKeyHash);
  if (admission === undefined) {
    throw new Error('xHarness attempt has no persisted admission');
  }
  return admission;
}

async function readStoredExecutionClaim(
  paths: RunRecordPaths,
  admission: XHarnessStoredRunAdmission,
): Promise<StoredExecutionClaim | undefined> {
  const value = await readJson(paths.execution);
  if (value === undefined) {
    return undefined;
  }
  const claim = parseStoredExecutionClaim(value);
  if (
    claim.attemptKeyHash !== admission.attemptKeyHash ||
    claim.admissionDigest !== admission.admissionDigest
  ) {
    throw new Error('xHarness execution claim has no matching admission');
  }
  return claim;
}

async function readJournalRecords(
  paths: RunRecordPaths,
  admission: XHarnessStoredRunAdmission,
): Promise<readonly StoredJournalEvent[]> {
  try {
    const status = await lstat(paths.eventsDirectory);
    if (!status.isDirectory()) {
      throw new Error('xHarness journal path is not a directory');
    }
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  const indexedEntries = (
    await readdir(paths.eventsDirectory, { withFileTypes: true })
  ).map((entry) => {
    const eventIndex = parseEventFileName(entry.name);
    if (!entry.isFile() || eventIndex === undefined) {
      throw new Error('xHarness journal contains an invalid entry');
    }
    return { eventIndex, name: entry.name };
  });
  indexedEntries.sort((left, right) => left.eventIndex - right.eventIndex);

  const records: StoredJournalEvent[] = [];
  let previousEventDigest: string | null = null;
  for (const [expectedIndex, entry] of indexedEntries.entries()) {
    if (entry.eventIndex !== expectedIndex) {
      throw new Error('xHarness journal is not contiguous');
    }
    const value = await readJson(join(paths.eventsDirectory, entry.name));
    if (value === undefined) {
      throw new Error('xHarness journal entry disappeared while reading');
    }
    const record = parseStoredJournalEvent(value);
    if (
      record.attemptKeyHash !== admission.attemptKeyHash ||
      record.admissionDigest !== admission.admissionDigest ||
      record.eventIndex !== expectedIndex ||
      record.previousEventDigest !== previousEventDigest
    ) {
      throw new Error('xHarness journal record linkage is invalid');
    }
    records.push(record);
    previousEventDigest = record.eventDigest;
  }
  return records;
}

function isTerminalEvent(
  event: AgentLoopKernelEvent | undefined,
): event is Extract<
  AgentLoopKernelEvent,
  { kind: 'round_completed'; outcome: 'terminal' }
> {
  return event?.kind === 'round_completed' && event.outcome === 'terminal';
}

function createJournalWriter(
  paths: RunRecordPaths,
  admission: XHarnessStoredRunAdmission,
  initialRecords: readonly StoredJournalEvent[],
): {
  appendEvent(event: AgentLoopKernelEvent): Promise<void>;
} {
  const events = initialRecords.map((record, index) =>
    parseHarnessRunTraceEvent(record.event, index),
  );
  let previousEventDigest = initialRecords.at(-1)?.eventDigest ?? null;
  let appendInFlight = false;

  return {
    async appendEvent(inputEvent) {
      if (appendInFlight) {
        throw new Error('xHarness journal append is already in progress');
      }
      if (isTerminalEvent(events.at(-1))) {
        throw new Error('xHarness terminal journal cannot be extended');
      }
      appendInFlight = true;
      try {
        const record = createStoredJournalEvent(
          admission,
          events.length,
          previousEventDigest,
          inputEvent,
        );
        await publishImmutableJson({
          path: join(paths.eventsDirectory, `${record.eventIndex}.json`),
          value: record,
          pendingDirectory: paths.pendingDirectory,
          allowIdenticalExisting: true,
          conflictMessage: 'xHarness journal event conflicts with stored data',
        });
        events.push(record.event);
        previousEventDigest = record.eventDigest;
      } finally {
        appendInFlight = false;
      }
    },
  };
}

function createTraceFromJournal(
  admission: XHarnessStoredRunAdmission,
  records: readonly StoredJournalEvent[],
): HarnessRunTrace {
  const events = createJournalEventView(records);
  const terminalEvent = events.at(-1);
  if (!isTerminalEvent(terminalEvent)) {
    throw new Error('xHarness journal is not a complete terminal trace');
  }
  return createHarnessRunTrace({
    ...admission.traceIdentity,
    harnessSnapshotId: admission.harnessSnapshot.harnessSnapshotId,
    loopImplementation: admission.loopImplementation,
    events,
    outcomeOk: terminalEvent.terminalOk,
  });
}

function createJournalEventView(
  records: readonly StoredJournalEvent[],
): readonly AgentLoopKernelEvent[] {
  return Object.freeze(
    records.map((record, index) =>
      parseHarnessRunTraceEvent(record.event, index),
    ),
  );
}

async function readStoredTraceForAdmission(
  paths: RunRecordPaths,
  admission: XHarnessStoredRunAdmission,
  records: readonly StoredJournalEvent[],
): Promise<XHarnessStoredRunTrace | undefined> {
  const value = await readJson(paths.trace);
  if (value === undefined) {
    return undefined;
  }
  const storedTrace = parseStoredTrace(value);
  if (
    storedTrace.attemptKeyHash !== admission.attemptKeyHash ||
    storedTrace.admissionDigest !== admission.admissionDigest
  ) {
    throw new Error('xHarness trace has no matching admission');
  }
  const journalTrace = createTraceFromJournal(admission, records);
  if (
    serializeHarnessRunTrace(journalTrace) !==
    serializeHarnessRunTrace(storedTrace.trace)
  ) {
    throw new Error('xHarness trace does not match its journal');
  }
  return storedTrace;
}

export function createXHarnessFileRunStore(root: string): XHarnessRunStore {
  if (!isAbsolute(root)) {
    throw new TypeError('xHarness run store root must be an absolute path');
  }
  const storeRoot = resolve(root);

  const store: XHarnessRunStore = {
    async listAttemptAdmissions() {
      return await listStoredAttemptAdmissions(storeRoot);
    },

    async readAttemptByReference(attemptKeyHashValue) {
      const attemptKeyHash = assertDigest(
        attemptKeyHashValue,
        'xHarness attempt reference',
      );
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      const admission = await readStoredAdmissionByReference(
        paths,
        attemptKeyHash,
      );
      if (admission === undefined) {
        return undefined;
      }
      const executionClaim = await readStoredExecutionClaim(paths, admission);
      const records = await readJournalRecords(paths, admission);
      const trace = await readStoredTraceForAdmission(
        paths,
        admission,
        records,
      );
      if (
        executionClaim === undefined &&
        (records.length > 0 || trace !== undefined)
      ) {
        throw new Error(
          'xHarness attempt has execution evidence without a claim',
        );
      }
      const state: XHarnessStoredRunAttemptState =
        trace !== undefined
          ? 'terminal'
          : executionClaim !== undefined
            ? 'execution_claimed'
            : 'admitted';
      return Object.freeze({
        state,
        admission,
        events: createJournalEventView(records),
        ...(trace === undefined ? {} : { trace }),
      });
    },

    async admitRun(attemptKey, input) {
      const attemptKeyHash = hashAttemptKey(attemptKey);
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      const canonicalInput = canonicalizeAdmissionInput(input);
      const storedAdmission = createStoredAdmission(
        attemptKeyHash,
        canonicalInput,
      );
      await publishImmutableJson({
        path: paths.admission,
        value: storedAdmission,
        pendingDirectory: paths.pendingDirectory,
        allowIdenticalExisting: true,
        conflictMessage:
          'xHarness attempt admission conflicts with stored data',
      });

      const implementation = Object.freeze({
        implementationId: canonicalInput.implementation.implementationId,
        contractVersion: canonicalInput.implementation.contractVersion,
        async run<
          TResult extends { ok: boolean },
          TFunctionCall,
          TStructuredOutput,
          THistoryItem,
        >(
          args: AgentLoopKernelInput<
            TResult,
            TFunctionCall,
            TStructuredOutput,
            THistoryItem
          >,
        ): Promise<TResult> {
          if (args.ports.checkpointEvent !== undefined) {
            throw new Error(
              'xHarness journaled execution cannot replace an existing checkpointEvent port',
            );
          }
          const executionClaim: StoredExecutionClaim = {
            schemaVersion: 1,
            attemptKeyHash,
            admissionDigest: storedAdmission.admissionDigest,
          };
          await publishImmutableJson({
            path: paths.execution,
            value: executionClaim,
            pendingDirectory: paths.pendingDirectory,
            allowIdenticalExisting: false,
            conflictMessage: 'xHarness attempt execution is already claimed',
          });
          const initialRecords = await readJournalRecords(
            paths,
            storedAdmission,
          );
          if (initialRecords.length > 0) {
            throw new Error(
              'xHarness claimed execution cannot start from an existing journal prefix',
            );
          }
          const writer = createJournalWriter(
            paths,
            storedAdmission,
            initialRecords,
          );
          const result = await canonicalInput.implementation.run({
            ...args,
            ports: {
              ...args.ports,
              checkpointEvent(event) {
                return writer.appendEvent(event);
              },
            },
          });
          const storedTrace = await store.publishTerminalTrace(attemptKey);
          if (storedTrace.trace.outcome.ok !== result.ok) {
            throw new Error(
              'xHarness terminal trace does not match the implementation result',
            );
          }
          return result;
        },
      }) satisfies AgentLoopImplementation;

      return Object.freeze({
        harnessSnapshot: canonicalInput.harnessSnapshot,
        traceIdentity: canonicalInput.traceIdentity,
        ...(canonicalInput.evidenceReferenceId === undefined
          ? {}
          : { evidenceReferenceId: canonicalInput.evidenceReferenceId }),
        implementation,
      });
    },

    async readAdmission(attemptKey) {
      const attemptKeyHash = hashAttemptKey(attemptKey);
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      return await readStoredAdmissionByReference(paths, attemptKeyHash);
    },

    async readJournal(attemptKey) {
      const attemptKeyHash = hashAttemptKey(attemptKey);
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      const admission = await requireStoredAdmission(paths, attemptKeyHash);
      const records = await readJournalRecords(paths, admission);
      return createJournalEventView(records);
    },

    async publishTerminalTrace(attemptKey) {
      const attemptKeyHash = hashAttemptKey(attemptKey);
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      const admission = await requireStoredAdmission(paths, attemptKeyHash);
      const records = await readJournalRecords(paths, admission);
      const trace = createTraceFromJournal(admission, records);
      const storedTrace = Object.freeze({
        schemaVersion: 1 as const,
        attemptKeyHash,
        admissionDigest: admission.admissionDigest,
        trace,
      });
      await publishImmutableJson({
        path: paths.trace,
        value: storedTrace,
        pendingDirectory: paths.pendingDirectory,
        allowIdenticalExisting: true,
        conflictMessage: 'xHarness terminal trace conflicts with stored data',
      });
      return storedTrace;
    },

    async readTrace(attemptKey) {
      const attemptKeyHash = hashAttemptKey(attemptKey);
      const paths = createRecordPaths(storeRoot, attemptKeyHash);
      const admission = await requireStoredAdmission(paths, attemptKeyHash);
      const records = await readJournalRecords(paths, admission);
      return await readStoredTraceForAdmission(paths, admission, records);
    },
  };
  return store;
}
