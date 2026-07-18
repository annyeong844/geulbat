import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hashPtcSha256Hex } from '../../shared/sha256.js';
import type {
  PtcExecuteCodeStoreCommitSummary,
  PtcExecuteCodeStoreConflict,
  PtcExecuteCodeStoreDiscardSummary,
  PtcExecuteCodeStoreError,
  PtcExecuteCodeStoreErrorCode,
} from './execute-code-runtime-contract.js';

export const PTC_EXECUTE_CODE_STORE_ENABLED_ENV =
  'GEULBAT_PTC_STORE_ENABLED' as const;
export const PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV =
  'GEULBAT_PTC_STORE_MAX_KEYS' as const;
export const PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV =
  'GEULBAT_PTC_STORE_MAX_VALUE_BYTES' as const;
export const PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV =
  'GEULBAT_PTC_STORE_MAX_TOTAL_BYTES' as const;

const PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_KEYS = 256;
const PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_VALUE_BYTES = 262_144;
const PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_TOTAL_BYTES = 4_194_304;
const PTC_EXECUTE_CODE_STORE_MAX_KEY_BYTES = 512;
const PTC_EXECUTE_CODE_STORE_FORMAT_VERSION = 1;

type PtcExecuteCodeStoreEnv = Readonly<
  Partial<
    Record<
      | typeof PTC_EXECUTE_CODE_STORE_ENABLED_ENV
      | typeof PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV
      | typeof PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV
      | typeof PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV,
      string | undefined
    >
  >
>;

export type PtcExecuteCodeStoreRuntimeConfig =
  | { enabled?: false }
  | {
      enabled: true;
      maxKeys: number;
      maxValueBytes: number;
      maxTotalBytes: number;
    };

type PtcExecuteCodeStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PtcExecuteCodeStoreError };

interface PtcExecuteCodeStoreEntry {
  value: unknown;
  revision: number;
  lastWriterExecutionId: string;
}

interface PtcExecuteCodeStoreWrite {
  value: unknown;
  baseRevision: number;
}

interface PtcExecuteCodePersistedStore {
  formatVersion: typeof PTC_EXECUTE_CODE_STORE_FORMAT_VERSION;
  runScope: 'main';
  entries: Array<
    PtcExecuteCodeStoreEntry & {
      key: string;
    }
  >;
}

export interface PtcExecuteCodeStoreExecution {
  get(key: unknown): PtcExecuteCodeStoreResult<unknown>;
  set(
    key: unknown,
    value: unknown,
    options?: unknown,
  ): PtcExecuteCodeStoreResult<undefined>;
  commit(): Promise<
    PtcExecuteCodeStoreResult<PtcExecuteCodeStoreCommitSummary>
  >;
  discard(): PtcExecuteCodeStoreDiscardSummary;
  pendingWriteCount(): number;
}

export interface PtcExecuteCodeStore {
  beginExecution(args: {
    threadId: string;
    executionId: string;
  }): Promise<PtcExecuteCodeStoreResult<PtcExecuteCodeStoreExecution>>;
}

const ptcStoreThreadTails = new Map<string, Promise<void>>();

export function resolvePtcExecuteCodeStoreConfigFromEnv(
  env: PtcExecuteCodeStoreEnv = process.env,
): PtcExecuteCodeStoreRuntimeConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_STORE_ENABLED_ENV];
  const maxKeysRaw = env[PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV];
  const maxValueBytesRaw = env[PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV];
  const maxTotalBytesRaw = env[PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV];
  const hasLimit =
    maxKeysRaw !== undefined ||
    maxValueBytesRaw !== undefined ||
    maxTotalBytesRaw !== undefined;

  if (enabledRaw === undefined) {
    if (hasLimit) {
      throw new Error(
        `PTC execute_code store limits require ${PTC_EXECUTE_CODE_STORE_ENABLED_ENV}=true`,
      );
    }
    return undefined;
  }

  const enabled = readStoreBooleanEnv(
    PTC_EXECUTE_CODE_STORE_ENABLED_ENV,
    enabledRaw,
  );
  if (!enabled) {
    if (hasLimit) {
      throw new Error(
        `PTC execute_code store limits require ${PTC_EXECUTE_CODE_STORE_ENABLED_ENV}=true`,
      );
    }
    return Object.freeze({ enabled: false });
  }

  return Object.freeze({
    enabled: true,
    maxKeys:
      maxKeysRaw === undefined
        ? PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_KEYS
        : readStorePositiveIntegerEnv(
            PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV,
            maxKeysRaw,
          ),
    maxValueBytes:
      maxValueBytesRaw === undefined
        ? PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_VALUE_BYTES
        : readStorePositiveIntegerEnv(
            PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV,
            maxValueBytesRaw,
          ),
    maxTotalBytes:
      maxTotalBytesRaw === undefined
        ? PTC_EXECUTE_CODE_STORE_DEFAULT_MAX_TOTAL_BYTES
        : readStorePositiveIntegerEnv(
            PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV,
            maxTotalBytesRaw,
          ),
  });
}

export function createPtcExecuteCodeStore(args: {
  rootDir: string;
  config: Extract<PtcExecuteCodeStoreRuntimeConfig, { enabled: true }>;
}): PtcExecuteCodeStore {
  return {
    async beginExecution({
      threadId,
      executionId,
    }): Promise<PtcExecuteCodeStoreResult<PtcExecuteCodeStoreExecution>> {
      const filePath = resolvePtcExecuteCodeStoreThreadFilePath(
        args.rootDir,
        threadId,
      );
      const snapshotResult = await readPersistedStore(filePath);
      if (!snapshotResult.ok) {
        return snapshotResult;
      }

      const snapshot = snapshotResult.value;
      const writes = new Map<string, PtcExecuteCodeStoreWrite>();
      let acknowledgedSetCount = 0;
      let finalized = false;

      const requireActive = (): PtcExecuteCodeStoreResult<undefined> =>
        finalized
          ? {
              ok: false,
              error: storeError(
                'StoreExecutionFinalized',
                'The PTC store execution is already finalized',
                'Start a new exec before calling geulbat.store again.',
              ),
            }
          : { ok: true, value: undefined };

      return {
        ok: true,
        value: {
          get(keyInput): PtcExecuteCodeStoreResult<unknown> {
            const active = requireActive();
            if (!active.ok) {
              return active;
            }
            const keyResult = validateStoreKey(keyInput);
            if (!keyResult.ok) {
              return keyResult;
            }
            const key = keyResult.value;
            const pending = writes.get(key);
            if (pending !== undefined) {
              return { ok: true, value: cloneJsonValue(pending.value) };
            }
            const entry = snapshot.get(key);
            return {
              ok: true,
              value:
                entry === undefined ? undefined : cloneJsonValue(entry.value),
            };
          },

          set(keyInput, value, options): PtcExecuteCodeStoreResult<undefined> {
            const active = requireActive();
            if (!active.ok) {
              return active;
            }
            const keyResult = validateStoreKey(keyInput);
            if (!keyResult.ok) {
              return keyResult;
            }
            const optionsResult = validateStoreSetOptions(options);
            if (!optionsResult.ok) {
              return optionsResult;
            }
            const valueResult = serializeStoreValue(value);
            if (!valueResult.ok) {
              return valueResult;
            }
            if (valueResult.value.bytes > args.config.maxValueBytes) {
              return {
                ok: false,
                error: storeError(
                  'StoreMaxValueBytesExceeded',
                  'The PTC store value exceeds the configured byte limit',
                  'Reduce the serialized value size and call geulbat.store.set again.',
                  {
                    valueBytes: valueResult.value.bytes,
                    maxValueBytes: args.config.maxValueBytes,
                  },
                ),
              };
            }

            const key = keyResult.value;
            const candidateWrites = new Map(writes);
            candidateWrites.set(key, {
              value: valueResult.value.value,
              baseRevision: snapshot.get(key)?.revision ?? 0,
            });
            const candidate = mergeStoreEntries(snapshot, candidateWrites, {
              executionId,
              advanceRevision: false,
            });
            const limits = validateStoreLimits(candidate, args.config);
            if (!limits.ok) {
              return limits;
            }

            writes.set(key, candidateWrites.get(key)!);
            acknowledgedSetCount += 1;
            return { ok: true, value: undefined };
          },

          async commit(): Promise<
            PtcExecuteCodeStoreResult<PtcExecuteCodeStoreCommitSummary>
          > {
            const active = requireActive();
            if (!active.ok) {
              return active;
            }
            finalized = true;

            return await runPtcStoreThreadSerial(filePath, async () => {
              const currentResult = await readPersistedStore(filePath);
              if (!currentResult.ok) {
                return currentResult;
              }
              const current = currentResult.value;
              const conflicts = collectStoreConflicts(current, writes);
              if (conflicts.length > 0) {
                const firstKey = conflicts[0]?.key ?? '';
                return {
                  ok: false,
                  error: storeError(
                    'StoreCommitConflict',
                    'The PTC store write set conflicts with a newer committed revision',
                    `Call geulbat.store.get(${JSON.stringify(firstKey)}) to read the current revision, re-apply the change, then call geulbat.store.set again.`,
                    { conflicts },
                  ),
                };
              }

              if (writes.size === 0) {
                return {
                  ok: true,
                  value: { committedKeys: [], revisions: {} },
                };
              }

              const merged = mergeStoreEntries(current, writes, {
                executionId,
                advanceRevision: true,
              });
              const limits = validateStoreLimits(merged, args.config);
              if (!limits.ok) {
                return limits;
              }
              const persisted = serializePersistedStore(merged);
              try {
                await writePtcStoreFileAtomically(filePath, persisted);
              } catch (error: unknown) {
                return persistenceFailure(error);
              }

              const committedKeys = [...writes.keys()].sort();
              const revisions: Record<string, number> = {};
              for (const key of committedKeys) {
                const entry = merged.get(key);
                if (entry !== undefined) {
                  revisions[key] = entry.revision;
                }
              }
              return { ok: true, value: { committedKeys, revisions } };
            });
          },

          discard(): PtcExecuteCodeStoreDiscardSummary {
            if (finalized) {
              return { discardedWrites: 0 };
            }
            finalized = true;
            writes.clear();
            return { discardedWrites: acknowledgedSetCount };
          },

          pendingWriteCount(): number {
            return writes.size;
          },
        },
      };
    },
  };
}

function resolvePtcExecuteCodeStoreThreadFilePath(
  rootDir: string,
  threadId: string,
): string {
  return join(rootDir, `thread-${hashPtcSha256Hex(threadId)}.json`);
}

function readStoreBooleanEnv(name: string, raw: string): boolean {
  const value = raw.trim();
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`invalid ${name}: ${value || 'empty'}`);
}

function readStorePositiveIntegerEnv(name: string, raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function validateStoreKey(key: unknown): PtcExecuteCodeStoreResult<string> {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    Buffer.byteLength(key, 'utf8') > PTC_EXECUTE_CODE_STORE_MAX_KEY_BYTES
  ) {
    return {
      ok: false,
      error: storeError(
        'StoreInvalidKey',
        'PTC store keys must be non-empty strings of at most 512 UTF-8 bytes',
        'Use a shorter non-empty string key and call geulbat.store again.',
      ),
    };
  }
  return { ok: true, value: key };
}

function validateStoreSetOptions(
  options: unknown,
): PtcExecuteCodeStoreResult<undefined> {
  if (options === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    return {
      ok: false,
      error: storeError(
        'StoreOptionsInvalid',
        'PTC store set options must be an object',
        "Use no options or pass { merge: 'conflict' }.",
      ),
    };
  }
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== 'merge')) {
    return {
      ok: false,
      error: storeError(
        'StoreOptionsInvalid',
        'PTC store set options contain unsupported fields',
        "Use no options or pass only { merge: 'conflict' }.",
      ),
    };
  }
  const merge: unknown = Reflect.get(options, 'merge');
  if (merge !== undefined && merge !== 'conflict') {
    return {
      ok: false,
      error: storeError(
        'StoreMergePolicyUnsupported',
        'The requested PTC store merge policy is not supported',
        "Use the default conflict policy or pass { merge: 'conflict' }.",
      ),
    };
  }
  return { ok: true, value: undefined };
}

function serializeStoreValue(
  value: unknown,
): PtcExecuteCodeStoreResult<{ value: unknown; bytes: number }> {
  try {
    const invalidReason = findNonJsonValue(value, new Set<object>());
    if (invalidReason !== undefined) {
      return {
        ok: false,
        error: storeError(
          'StoreValueNotSerializable',
          `The PTC store value is not JSON round-trip serializable (${invalidReason})`,
          'Convert the value to finite JSON data and call geulbat.store.set again.',
        ),
      };
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('top-level value is not serializable');
    }
    return {
      ok: true,
      value: {
        value: JSON.parse(encoded) as unknown,
        bytes: Buffer.byteLength(encoded, 'utf8'),
      },
    };
  } catch {
    return {
      ok: false,
      error: storeError(
        'StoreValueNotSerializable',
        'The PTC store value is not JSON round-trip serializable',
        'Convert the value to finite JSON data and call geulbat.store.set again.',
      ),
    };
  }
}

function findNonJsonValue(
  value: unknown,
  ancestors: Set<object>,
): string | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return 'non-finite number';
    }
    return Object.is(value, -0)
      ? 'negative zero changes during JSON round-trip'
      : undefined;
  }
  if (typeof value !== 'object') {
    return `unsupported ${typeof value}`;
  }
  if (ancestors.has(value)) {
    return 'circular reference';
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (Array.isArray(value)) {
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        ancestors.delete(value);
        return 'sparse array';
      }
      const invalid = findNonJsonValue(value[index], ancestors);
      if (invalid !== undefined) {
        ancestors.delete(value);
        return invalid;
      }
    }
    ancestors.delete(value);
    return undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return 'non-plain object';
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return 'symbol property';
  }
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
    return 'non-enumerable property';
  }

  ancestors.add(value);
  for (const key of Object.keys(value)) {
    const invalid = findNonJsonValue(Reflect.get(value, key), ancestors);
    if (invalid !== undefined) {
      ancestors.delete(value);
      return invalid;
    }
  }
  ancestors.delete(value);
  return undefined;
}

async function readPersistedStore(
  filePath: string,
): Promise<PtcExecuteCodeStoreResult<Map<string, PtcExecuteCodeStoreEntry>>> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return { ok: true, value: new Map() };
    }
    return persistenceFailure(error);
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Reflect.get(parsed, 'formatVersion') !==
        PTC_EXECUTE_CODE_STORE_FORMAT_VERSION ||
      Reflect.get(parsed, 'runScope') !== 'main' ||
      !Array.isArray(Reflect.get(parsed, 'entries'))
    ) {
      throw new Error('invalid store envelope');
    }
    const entries = new Map<string, PtcExecuteCodeStoreEntry>();
    for (const candidate of Reflect.get(parsed, 'entries')) {
      if (candidate === null || typeof candidate !== 'object') {
        throw new Error('invalid store entry');
      }
      const keyResult = validateStoreKey(Reflect.get(candidate, 'key'));
      const valueResult = serializeStoreValue(Reflect.get(candidate, 'value'));
      const revision: unknown = Reflect.get(candidate, 'revision');
      const lastWriterExecutionId: unknown = Reflect.get(
        candidate,
        'lastWriterExecutionId',
      );
      if (
        !keyResult.ok ||
        !valueResult.ok ||
        !Number.isSafeInteger(revision) ||
        Number(revision) < 1 ||
        typeof lastWriterExecutionId !== 'string' ||
        lastWriterExecutionId.length === 0 ||
        entries.has(keyResult.value)
      ) {
        throw new Error('invalid store entry');
      }
      entries.set(keyResult.value, {
        value: valueResult.value.value,
        revision: Number(revision),
        lastWriterExecutionId,
      });
    }
    return { ok: true, value: entries };
  } catch (error: unknown) {
    return persistenceFailure(error);
  }
}

function collectStoreConflicts(
  current: Map<string, PtcExecuteCodeStoreEntry>,
  writes: Map<string, PtcExecuteCodeStoreWrite>,
): PtcExecuteCodeStoreConflict[] {
  const conflicts: PtcExecuteCodeStoreConflict[] = [];
  for (const [key, write] of writes) {
    const currentEntry = current.get(key);
    const currentRevision = currentEntry?.revision ?? 0;
    if (currentRevision !== write.baseRevision) {
      conflicts.push({
        key,
        baseRevision: write.baseRevision,
        currentRevision,
        ...(currentEntry === undefined
          ? {}
          : { lastWriterExecutionId: currentEntry.lastWriterExecutionId }),
      });
    }
  }
  return conflicts.sort((left, right) => left.key.localeCompare(right.key));
}

function mergeStoreEntries(
  base: Map<string, PtcExecuteCodeStoreEntry>,
  writes: Map<string, PtcExecuteCodeStoreWrite>,
  args: { executionId: string; advanceRevision: boolean },
): Map<string, PtcExecuteCodeStoreEntry> {
  const merged = new Map(base);
  for (const [key, write] of writes) {
    const current = base.get(key);
    merged.set(key, {
      value: cloneJsonValue(write.value),
      revision: args.advanceRevision
        ? (current?.revision ?? 0) + 1
        : (current?.revision ?? 0),
      lastWriterExecutionId: args.executionId,
    });
  }
  return merged;
}

function validateStoreLimits(
  entries: Map<string, PtcExecuteCodeStoreEntry>,
  config: Extract<PtcExecuteCodeStoreRuntimeConfig, { enabled: true }>,
): PtcExecuteCodeStoreResult<undefined> {
  if (entries.size > config.maxKeys) {
    return {
      ok: false,
      error: storeError(
        'StoreMaxKeysExceeded',
        'The PTC store exceeds the configured key limit',
        'Reuse an existing key or ask the operator to increase GEULBAT_PTC_STORE_MAX_KEYS.',
        { keyCount: entries.size, maxKeys: config.maxKeys },
      ),
    };
  }

  let totalBytes = 0;
  for (const entry of entries.values()) {
    const serialized = JSON.stringify(entry.value);
    const valueBytes = Buffer.byteLength(serialized, 'utf8');
    if (valueBytes > config.maxValueBytes) {
      return {
        ok: false,
        error: storeError(
          'StoreMaxValueBytesExceeded',
          'The PTC store value exceeds the configured byte limit',
          'Reduce the serialized value size and call geulbat.store.set again.',
          { valueBytes, maxValueBytes: config.maxValueBytes },
        ),
      };
    }
    totalBytes += valueBytes;
  }
  if (totalBytes > config.maxTotalBytes) {
    return {
      ok: false,
      error: storeError(
        'StoreMaxTotalBytesExceeded',
        'The PTC store exceeds the configured total byte limit',
        'Reduce the values stored in this thread and call geulbat.store.set again.',
        { totalBytes, maxTotalBytes: config.maxTotalBytes },
      ),
    };
  }
  return { ok: true, value: undefined };
}

function serializePersistedStore(
  entries: Map<string, PtcExecuteCodeStoreEntry>,
): string {
  const persisted: PtcExecuteCodePersistedStore = {
    formatVersion: PTC_EXECUTE_CODE_STORE_FORMAT_VERSION,
    runScope: 'main',
    entries: [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => ({ key, ...entry })),
  };
  return `${JSON.stringify(persisted)}\n`;
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function persistenceFailure(_error: unknown): {
  ok: false;
  error: PtcExecuteCodeStoreError;
} {
  return {
    ok: false,
    error: storeError(
      'StorePersistenceUnavailable',
      'PTC store persistence is unavailable',
      'Do not retry the same write blindly; verify the state store is writable, then start a new exec.',
      { persistenceFailed: true },
    ),
  };
}

function storeError(
  errorCode: PtcExecuteCodeStoreErrorCode,
  message: string,
  remediation: string,
  details?: Record<string, unknown>,
): PtcExecuteCodeStoreError {
  return {
    errorCode,
    message,
    remediation,
    ...(details === undefined ? {} : { details }),
  };
}

async function runPtcStoreThreadSerial<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = ptcStoreThreadTails.get(key) ?? Promise.resolve();
  const waitForPrevious = () =>
    previous.then(
      () => undefined,
      () => undefined,
    );
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = waitForPrevious().then(() => current);
  ptcStoreThreadTails.set(key, queued);

  await waitForPrevious();
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (ptcStoreThreadTails.get(key) === queued) {
      ptcStoreThreadTails.delete(key);
    }
  }
}

async function writePtcStoreFileAtomically(
  targetPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, targetPath);
  } catch (error: unknown) {
    try {
      await unlink(tempPath);
    } catch (cleanupError: unknown) {
      if (!hasNodeErrorCode(cleanupError, 'ENOENT')) {
        throw new AggregateError(
          [error, cleanupError],
          'PTC store atomic write and temp cleanup failed',
        );
      }
    }
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === code
  );
}
