import { createSignal } from '../utils/signal.js';

export type SandboxAttemptStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'crashed'
  | 'abandoned';

export type SandboxTerminalStatus = Exclude<
  SandboxAttemptStatus,
  'queued' | 'running' | 'cancelling'
>;

export interface SandboxAttemptOwner {
  projectId?: string;
  threadId?: string;
  runId?: string;
}

export type SandboxAttemptCapabilityClass =
  | 'candidate_generation'
  | 'read_only'
  | 'workspace_mutating';

export type SandboxAttemptExecutionClass =
  | 'in_process_adapter'
  | 'docker_worker'
  | 'sandbox_job';

export type SandboxAttemptCommitBehavior =
  | 'not_applicable'
  | 'candidate_only'
  | 'requires_commit_gate';

export type SandboxAttemptPolicyValue = string | number | boolean;

export interface SandboxAttemptCapabilityProjection {
  schemaVersion: 1;
  capabilityId: string;
  capabilityClass: SandboxAttemptCapabilityClass;
  executionClass: SandboxAttemptExecutionClass;
  commitBehavior: SandboxAttemptCommitBehavior;
  policies: Record<string, SandboxAttemptPolicyValue>;
}

export interface SandboxOutputFileRef {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface SandboxOutputRef {
  evidenceRef: string;
  rootPath: string;
  files: readonly SandboxOutputFileRef[];
  totalBytes: number;
}

export interface SandboxAttemptSnapshot {
  jobId: string;
  attemptId: string;
  previousAttemptId: string | null;
  jobKind: string;
  adapterKind: string;
  owner: SandboxAttemptOwner;
  capability: SandboxAttemptCapabilityProjection | null;
  status: SandboxAttemptStatus;
  rootPath: string | null;
  exitCode: number | null;
  diagnostics: string | null;
  outputRef: SandboxOutputRef | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface SandboxAttemptStore {
  createAttempt(args: {
    jobKind: string;
    adapterKind: string;
    owner?: SandboxAttemptOwner;
    capability?: SandboxAttemptCapabilityProjection;
  }): SandboxAttemptSnapshot;
  retryAttempt(attemptId: string): SandboxAttemptSnapshot;
  markRunning(
    attemptId: string,
    args: { rootPath: string },
  ): SandboxAttemptSnapshot | undefined;
  markTerminal(
    attemptId: string,
    args: {
      status: SandboxTerminalStatus;
      exitCode?: number | null;
      diagnostics?: string | null;
      outputRef?: SandboxOutputRef | null;
    },
  ): SandboxAttemptSnapshot | undefined;
  getAttempt(attemptId: string): SandboxAttemptSnapshot | undefined;
  getAttempts(attemptIds?: readonly string[]): {
    revision: number;
    records: SandboxAttemptSnapshot[];
  };
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

export function createSandboxAttemptStore(
  options: {
    now?: () => string;
  } = {},
): SandboxAttemptStore {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map<string, SandboxAttemptSnapshot>();
  const signal = createSignal<[number]>();
  let revision = 0;
  let nextJob = 1;
  let nextAttempt = 1;

  const bumpRevision = (): void => {
    revision += 1;
    signal.emit(revision);
  };

  const cloneCapability = (
    capability: SandboxAttemptCapabilityProjection,
  ): SandboxAttemptCapabilityProjection => ({
    ...capability,
    policies: { ...capability.policies },
  });

  const clone = (snapshot: SandboxAttemptSnapshot): SandboxAttemptSnapshot => ({
    ...snapshot,
    owner: { ...snapshot.owner },
    capability:
      snapshot.capability === null
        ? null
        : cloneCapability(snapshot.capability),
    outputRef:
      snapshot.outputRef === null
        ? null
        : {
            ...snapshot.outputRef,
            files: snapshot.outputRef.files.map((file) => ({ ...file })),
          },
  });

  const createSnapshot = (args: {
    jobId: string;
    previousAttemptId: string | null;
    jobKind: string;
    adapterKind: string;
    owner?: SandboxAttemptOwner;
    capability?: SandboxAttemptCapabilityProjection;
  }): SandboxAttemptSnapshot => {
    const timestamp = now();
    return {
      jobId: args.jobId,
      attemptId: `sandbox-attempt-${nextAttempt++}`,
      previousAttemptId: args.previousAttemptId,
      jobKind: args.jobKind,
      adapterKind: args.adapterKind,
      owner: { ...(args.owner ?? {}) },
      capability: args.capability ? cloneCapability(args.capability) : null,
      status: 'queued',
      rootPath: null,
      exitCode: null,
      diagnostics: null,
      outputRef: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    };
  };

  const waitForRevisionChange = (
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number> => {
    if (revision !== afterRevision) {
      return Promise.resolve(revision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = (): void => {
        finish(() => reject(new Error('sandbox attempt wait aborted')));
      };

      unsubscribe = signal.subscribe((nextRevision) => {
        if (nextRevision !== afterRevision) {
          finish(() => resolve(nextRevision));
        }
      });

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  return {
    createAttempt(args) {
      const snapshot = createSnapshot({
        ...args,
        jobId: `sandbox-job-${nextJob++}`,
        previousAttemptId: null,
      });
      records.set(snapshot.attemptId, snapshot);
      bumpRevision();
      return clone(snapshot);
    },
    retryAttempt(attemptId) {
      const previous = records.get(attemptId);
      if (!previous) {
        throw new Error(`sandbox attempt not found: ${attemptId}`);
      }
      if (!isSandboxAttemptTerminalStatus(previous.status)) {
        throw new Error(
          `cannot retry non-terminal sandbox attempt: ${attemptId}`,
        );
      }
      const snapshot = createSnapshot({
        jobId: previous.jobId,
        previousAttemptId: previous.attemptId,
        jobKind: previous.jobKind,
        adapterKind: previous.adapterKind,
        owner: previous.owner,
        ...(previous.capability === null
          ? {}
          : { capability: previous.capability }),
      });
      records.set(snapshot.attemptId, snapshot);
      bumpRevision();
      return clone(snapshot);
    },
    markRunning(attemptId, args) {
      const current = records.get(attemptId);
      if (!current || current.status !== 'queued') {
        return current ? clone(current) : undefined;
      }
      const timestamp = now();
      const next = {
        ...current,
        status: 'running' as const,
        rootPath: args.rootPath,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      records.set(attemptId, next);
      bumpRevision();
      return clone(next);
    },
    markTerminal(attemptId, args) {
      const current = records.get(attemptId);
      if (!current || isSandboxAttemptTerminalStatus(current.status)) {
        return current ? clone(current) : undefined;
      }
      const timestamp = now();
      const next = {
        ...current,
        status: args.status,
        exitCode: args.exitCode ?? null,
        diagnostics: args.diagnostics ?? null,
        outputRef: args.outputRef ?? null,
        completedAt: timestamp,
        updatedAt: timestamp,
      };
      records.set(attemptId, next);
      bumpRevision();
      return clone(next);
    },
    getAttempt(attemptId) {
      const snapshot = records.get(attemptId);
      return snapshot ? clone(snapshot) : undefined;
    },
    getAttempts(attemptIds) {
      const selected =
        attemptIds === undefined
          ? [...records.values()]
          : attemptIds.flatMap((attemptId) => {
              const snapshot = records.get(attemptId);
              return snapshot ? [snapshot] : [];
            });
      return { revision, records: selected.map(clone) };
    },
    waitForRevisionChange,
  };
}

export function isSandboxAttemptTerminalStatus(
  status: SandboxAttemptStatus,
): status is SandboxTerminalStatus {
  return (
    status === 'cancelled' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'crashed' ||
    status === 'abandoned'
  );
}
