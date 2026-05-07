import type {
  GeulbatRuntimePersistenceError,
  PersistenceBootstrapWindow,
  PersistenceRecord,
  SessionStorageRecord,
} from './artifact-runtime-persistence-bootstrap-types.js';
import type { PersistenceRawApi } from './artifact-runtime-persistence-mutation-queue.js';

export interface ArtifactRuntimePersistenceStorageFacadeStore {
  createPersistenceError(
    code: string,
    message: string,
  ): GeulbatRuntimePersistenceError;
  assertStorageBootstrapReady(): void;
  assertSharedStorageAvailable(): void;
  ensureStorageReady(window: PersistenceBootstrapWindow): Promise<void>;
  cloneJsonValue<T>(value: T): T;
  listStorageKeys(): string[];
  listSessionStorageKeys(): string[];
  listDatabaseKeys(): string[];
  assertStorageKey(key: unknown): asserts key is string;
  assertStorageValue(value: unknown): void;
  assertDatabaseKey(key: unknown): asserts key is string;
  assertDatabaseValue(value: unknown): void;
  waitForCommittedStorageWrites(): Promise<void>;
  normalizeStorageKey(key: unknown): string;
  normalizeDatabaseKey(key: unknown): string;
  normalizeStorageIndex(index: unknown): number | null;
  schedulePersistedMutation(
    rawPersistenceApi: PersistenceRawApi,
    applyMutation: (next: {
      storageMap: PersistenceRecord;
      databaseMap: PersistenceRecord;
    }) => void,
  ): Promise<void>;
  createNextSessionStorageMap(
    mutate: (map: SessionStorageRecord) => void,
  ): SessionStorageRecord;
  replaceCurrentSessionStorageMap(next: SessionStorageRecord): void;
  readCurrentStorageMap(): PersistenceRecord;
  readCurrentSessionStorageMap(): SessionStorageRecord;
  readCurrentDatabaseMap(): PersistenceRecord;
}
