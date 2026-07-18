import type {
  GeulbatRuntimePersistenceError,
  PersistenceBootstrapSuccessResponseMessage,
  PersistenceRecord,
} from './artifact-runtime-persistence-bootstrap-types.js';
import type {
  ArtifactRuntimePersistenceAuthorityState,
  PersistenceAuthoritySnapshot,
  PersistenceStateMutation,
} from './artifact-runtime-persistence-authority-state.js';

export interface PersistenceRawApi {
  loadState(): Promise<PersistenceBootstrapSuccessResponseMessage>;
  saveState(
    state: unknown,
    expectedRevision: string | null,
  ): Promise<PersistenceBootstrapSuccessResponseMessage>;
  clearState(
    expectedRevision: string | null,
  ): Promise<PersistenceBootstrapSuccessResponseMessage>;
}

interface MutationQueueArgs {
  authorityState: ArtifactRuntimePersistenceAuthorityState;
  createPersistenceError(
    this: void,
    code: string,
    message: string,
  ): GeulbatRuntimePersistenceError;
  stabilizePersistenceError(
    this: void,
    error: unknown,
  ): GeulbatRuntimePersistenceError;
  isPersistenceConflict(this: void, error: unknown): boolean;
  assertSharedStorageAvailable(this: void): void;
  loadCurrentAuthorityState(
    this: void,
    rawPersistenceApi: PersistenceRawApi,
  ): Promise<PersistenceAuthoritySnapshot>;
  persistCurrentAuthorityState(
    this: void,
    rawPersistenceApi: PersistenceRawApi,
    storageRecord: PersistenceRecord,
    databaseRecord: PersistenceRecord,
    revision: string | null,
  ): Promise<PersistenceBootstrapSuccessResponseMessage>;
  markStorageUnavailable(
    this: void,
    error: unknown,
  ): GeulbatRuntimePersistenceError;
}

const STORAGE_RETRY_LIMIT = 3;

export function createArtifactRuntimePersistenceMutationQueue({
  authorityState,
  createPersistenceError,
  stabilizePersistenceError,
  isPersistenceConflict,
  assertSharedStorageAvailable,
  loadCurrentAuthorityState,
  persistCurrentAuthorityState,
  markStorageUnavailable,
}: MutationQueueArgs) {
  let storageWriteQueue: Promise<void> = Promise.resolve();
  let pendingMutationIndex = 0;
  const pendingMutations: PersistenceStateMutation[] = [];

  const waitForCommittedStorageWrites = () =>
    storageWriteQueue.then(
      () => undefined,
      () => undefined,
    );

  const enqueueStorageWrite = <T>(operation: () => Promise<T>) => {
    const result = storageWriteQueue.then(operation, operation);
    storageWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const removePendingMutation = (mutationId: number) => {
    const targetIndex = pendingMutations.findIndex(
      (mutation) => mutation.id === mutationId,
    );
    if (targetIndex >= 0) {
      pendingMutations.splice(targetIndex, 1);
    }
  };

  const schedulePersistedMutation = (
    rawPersistenceApi: PersistenceRawApi,
    applyMutation: (next: {
      storageMap: PersistenceRecord;
      databaseMap: PersistenceRecord;
    }) => void,
  ) => {
    pendingMutationIndex += 1;
    const pendingMutation: PersistenceStateMutation = {
      id: pendingMutationIndex,
      apply: applyMutation,
    };
    pendingMutations.push(pendingMutation);
    authorityState.refreshCurrentAuthorityState(pendingMutations);

    return enqueueStorageWrite(async () => {
      assertSharedStorageAvailable();
      let remaining = STORAGE_RETRY_LIMIT;

      while (remaining-- > 0) {
        const next = authorityState.buildStateThroughMutation(
          pendingMutations,
          pendingMutation.id,
        );
        if (!next) {
          return;
        }
        const persistResult = await persistCurrentAuthorityState(
          rawPersistenceApi,
          next.storageMap,
          next.databaseMap,
          authorityState.readCurrentStorageRevision(),
        ).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        if (persistResult.ok) {
          authorityState.replaceCommittedAuthorityState({
            storageMap: next.storageMap,
            databaseMap: next.databaseMap,
            revision: persistResult.result.revision ?? null,
          });
          removePendingMutation(pendingMutation.id);
          authorityState.refreshCurrentAuthorityState(pendingMutations);
          return;
        }

        if (isPersistenceConflict(persistResult.error) && remaining > 0) {
          authorityState.replaceCommittedAuthorityState(
            await loadCurrentAuthorityState(rawPersistenceApi),
          );
          authorityState.refreshCurrentAuthorityState(pendingMutations);
          continue;
        }

        if (isPersistenceConflict(persistResult.error)) {
          break;
        }

        throw stabilizePersistenceError(persistResult.error);
      }

      throw createPersistenceError(
        'persistence_unavailable',
        'runtime storage is unavailable',
      );
    }).catch((error: unknown) => {
      throw markStorageUnavailable(error);
    });
  };

  return {
    waitForCommittedStorageWrites,
    schedulePersistedMutation,
  };
}
