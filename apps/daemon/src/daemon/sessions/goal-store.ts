import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isGoalCommand,
  isGoalSnapshot,
  type GoalCommand,
  type GoalRef,
  type GoalSnapshot,
} from '@geulbat/protocol/goal';
import {
  assertRunId,
  assertThreadId,
  isRunId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import { isRecord } from '../runtime-json.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage, isNotFoundError } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import {
  isRunExecutionTemplate,
  type RunExecutionTemplate,
} from './run-execution-template.js';

const LEGACY_GOAL_STORE_SCHEMA_VERSION = 1;
const GOAL_STORE_SCHEMA_VERSION = 2;

type LegacyGoalVerificationVoteRecord =
  | { verdict: 'achieved' }
  | { verdict: 'not_achieved'; unmetRequirements: string[] }
  | { verdict: 'unavailable'; reason: string };

type LegacyGoalVerificationOutcome =
  | { kind: 'achieved' }
  | { kind: 'incomplete'; unmetRequirements: string[] }
  | { kind: 'unavailable'; message: string };

interface StoredLegacyGoalVerificationAttempt {
  runId: RunId;
  attemptedAt: string;
  outcome: LegacyGoalVerificationOutcome;
  votes: LegacyGoalVerificationVoteRecord[];
}

interface StoredGoalCompletionAdmission {
  runId: RunId;
  admittedAt: string;
}

interface StoredCurrentGoal {
  snapshot: GoalSnapshot;
  executionTemplate: RunExecutionTemplate;
  completionRunId?: RunId;
  completionAdmissions: StoredGoalCompletionAdmission[];
  legacyVerificationAttempts: StoredLegacyGoalVerificationAttempt[];
}

interface StoredGoalState {
  schemaVersion: typeof GOAL_STORE_SCHEMA_VERSION;
  current: StoredCurrentGoal | null;
}

export interface GoalStore {
  readThread(threadId: ThreadId): Promise<GoalSnapshot | null>;
  enterOrResume(args: {
    threadId: ThreadId;
    requested: boolean;
    objective: string;
    executionTemplate: RunExecutionTemplate;
  }): Promise<GoalSnapshot | null>;
  readForRun(args: {
    threadId: ThreadId;
    ref?: GoalRef;
  }): Promise<GoalSnapshot | null>;
  resumeForRun(args: {
    threadId: ThreadId;
    ref: GoalRef;
    executionTemplate: RunExecutionTemplate;
  }): Promise<GoalSnapshot>;
  applyCommand(command: GoalCommand): Promise<{
    snapshot: GoalSnapshot | null;
    executionTemplate?: RunExecutionTemplate;
  }>;
  requestCompletion(args: {
    threadId: ThreadId;
    goalId: string;
    runId: RunId;
  }): Promise<GoalSnapshot>;
  admitCompletion(args: {
    threadId: ThreadId;
    goalId: string;
    runId: RunId;
  }): Promise<GoalSnapshot>;
}

export function createGoalStore(args: {
  stateRoot: string;
  now?: () => string;
  createId?: () => string;
}): GoalStore {
  const root = join(args.stateRoot, '.geulbat', 'goals');
  const now = args.now ?? (() => new Date().toISOString());
  const createId = args.createId ?? randomUUID;
  const runMutationSerial = createKeyedSerialRunner();
  const liveCompletionThreadIds = new Set<ThreadId>();

  function goalPath(threadId: ThreadId): string {
    return join(root, `${assertThreadId(threadId)}.json`);
  }

  async function readState(threadId: ThreadId): Promise<StoredGoalState> {
    try {
      return parseStoredGoalState(
        JSON.parse(await readFile(goalPath(threadId), 'utf8')),
      );
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return createEmptyGoalState();
      }
      throw new Error(`invalid Goal state: ${getErrorMessage(error)}`);
    }
  }

  async function writeState(
    threadId: ThreadId,
    state: StoredGoalState,
  ): Promise<void> {
    await writeTextFileAtomically(
      goalPath(threadId),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  async function readRecoveredState(
    threadId: ThreadId,
  ): Promise<StoredGoalState> {
    const state = await readState(threadId);
    const current = state.current;
    if (
      current?.snapshot.state !== 'verifying' ||
      liveCompletionThreadIds.has(threadId)
    ) {
      return state;
    }
    const recovered: StoredGoalState = {
      ...state,
      current: {
        executionTemplate: current.executionTemplate,
        completionAdmissions: current.completionAdmissions,
        legacyVerificationAttempts: current.legacyVerificationAttempts,
        snapshot: {
          ...current.snapshot,
          state: 'verification_unavailable',
          updatedAt: now(),
        },
      },
    };
    await writeState(threadId, recovered);
    return recovered;
  }

  async function readThread(threadId: ThreadId): Promise<GoalSnapshot | null> {
    const path = goalPath(threadId);
    return await runMutationSerial(path, async () => {
      return (await readRecoveredState(threadId)).current?.snapshot ?? null;
    });
  }

  async function enterOrResume({
    threadId,
    requested,
    objective,
    executionTemplate,
  }: {
    threadId: ThreadId;
    requested: boolean;
    objective: string;
    executionTemplate: RunExecutionTemplate;
  }): Promise<GoalSnapshot | null> {
    const path = goalPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readRecoveredState(threadId);
      const current = state.current;
      if (
        current !== null &&
        current.snapshot.state !== 'completed' &&
        (requested || isGoalRunState(current.snapshot.state))
      ) {
        if (requested && current.snapshot.objective !== objective.trim()) {
          throw goalConflict(
            'cancel or complete the current Goal before starting another one',
          );
        }
        const next: StoredGoalState = {
          ...state,
          current: { ...current, executionTemplate },
        };
        await writeState(threadId, next);
        return next.current?.snapshot ?? null;
      }
      if (!requested) {
        return current?.snapshot ?? null;
      }
      const normalizedObjective = objective.trim();
      if (normalizedObjective.length === 0) {
        throw goalConflict('Goal objective must not be blank');
      }
      const timestamp = now();
      const snapshot: GoalSnapshot = {
        goalId: `goal-${createId()}`,
        threadId,
        objective: normalizedObjective,
        state: 'working',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeState(threadId, {
        schemaVersion: GOAL_STORE_SCHEMA_VERSION,
        current: {
          snapshot,
          executionTemplate,
          completionAdmissions: [],
          legacyVerificationAttempts: [],
        },
      });
      return snapshot;
    });
  }

  async function readForRun({
    threadId,
    ref,
  }: {
    threadId: ThreadId;
    ref?: GoalRef;
  }): Promise<GoalSnapshot | null> {
    const path = goalPath(threadId);
    return await runMutationSerial(path, async () => {
      const current = (await readRecoveredState(threadId)).current;
      if (current === null) {
        if (ref !== undefined) {
          throw goalConflict('Goal is no longer current');
        }
        return null;
      }
      if (ref !== undefined) {
        if (current.snapshot.goalId !== ref.goalId) {
          throw goalConflict('Goal handoff is stale');
        }
        return current.snapshot;
      }
      return isGoalRunState(current.snapshot.state) ? current.snapshot : null;
    });
  }

  async function applyCommand(command: GoalCommand): Promise<{
    snapshot: GoalSnapshot | null;
    executionTemplate?: RunExecutionTemplate;
  }> {
    if (!isGoalCommand(command)) {
      throw goalConflict('invalid Goal command');
    }
    const path = goalPath(command.threadId);
    return await runMutationSerial(path, async () => {
      const state = await readRecoveredState(command.threadId);
      const current = state.current;
      if (current === null || current.snapshot.goalId !== command.goalId) {
        throw goalConflict('Goal is not current');
      }
      if (command.kind === 'cancel') {
        await writeState(command.threadId, {
          ...state,
          current: null,
        });
        liveCompletionThreadIds.delete(command.threadId);
        return { snapshot: null };
      }
      if (command.kind === 'pause') {
        if (
          current.snapshot.state !== 'working' &&
          current.snapshot.state !== 'continuing'
        ) {
          throw goalConflict('only a working Goal can be paused');
        }
        const snapshot: GoalSnapshot = {
          ...current.snapshot,
          state: 'paused',
          updatedAt: now(),
        };
        await writeState(command.threadId, {
          ...state,
          current: { ...current, snapshot },
        });
        return { snapshot };
      }
      if (
        current.snapshot.state !== 'paused' &&
        current.snapshot.state !== 'verification_unavailable'
      ) {
        throw goalConflict('only a paused Goal can be resumed');
      }
      return {
        snapshot: current.snapshot,
        executionTemplate: current.executionTemplate,
      };
    });
  }

  async function resumeForRun({
    threadId,
    ref,
    executionTemplate,
  }: {
    threadId: ThreadId;
    ref: GoalRef;
    executionTemplate: RunExecutionTemplate;
  }): Promise<GoalSnapshot> {
    const path = goalPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readRecoveredState(threadId);
      const current = requireCurrentGoal(state, ref.goalId);
      if (
        current.snapshot.state !== 'paused' &&
        current.snapshot.state !== 'verification_unavailable'
      ) {
        throw goalConflict('only a paused Goal can be resumed');
      }
      const snapshot: GoalSnapshot = {
        ...current.snapshot,
        state: 'working',
        updatedAt: now(),
      };
      await writeState(threadId, {
        ...state,
        current: { ...current, snapshot, executionTemplate },
      });
      return snapshot;
    });
  }

  async function requestCompletion({
    threadId,
    goalId,
    runId,
  }: {
    threadId: ThreadId;
    goalId: string;
    runId: RunId;
  }): Promise<GoalSnapshot> {
    const path = goalPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readRecoveredState(threadId);
      const current = requireCurrentGoal(state, goalId);
      if (
        current.snapshot.state !== 'working' &&
        current.snapshot.state !== 'continuing'
      ) {
        throw goalConflict('Goal is not ready for completion admission');
      }
      const snapshot: GoalSnapshot = {
        ...current.snapshot,
        state: 'verifying',
        updatedAt: now(),
      };
      await writeState(threadId, {
        ...state,
        current: {
          ...current,
          snapshot,
          completionRunId: assertRunId(runId),
        },
      });
      liveCompletionThreadIds.add(threadId);
      return snapshot;
    });
  }

  async function admitCompletion({
    threadId,
    goalId,
    runId,
  }: {
    threadId: ThreadId;
    goalId: string;
    runId: RunId;
  }): Promise<GoalSnapshot> {
    const path = goalPath(threadId);
    try {
      return await runMutationSerial(path, async () => {
        const state = await readState(threadId);
        const current = requireCurrentGoal(state, goalId);
        if (
          current.snapshot.state !== 'verifying' ||
          current.completionRunId !== runId
        ) {
          throw goalConflict('Goal completion request is no longer current');
        }
        const admittedAt = now();
        const snapshot: GoalSnapshot = {
          ...current.snapshot,
          state: 'completed',
          updatedAt: admittedAt,
        };
        await writeState(threadId, {
          ...state,
          current: {
            executionTemplate: current.executionTemplate,
            snapshot,
            completionAdmissions: [
              ...current.completionAdmissions,
              {
                runId,
                admittedAt,
              },
            ],
            legacyVerificationAttempts: current.legacyVerificationAttempts,
          },
        });
        return snapshot;
      });
    } finally {
      liveCompletionThreadIds.delete(threadId);
    }
  }

  return {
    readThread,
    enterOrResume,
    readForRun,
    resumeForRun,
    applyCommand,
    requestCompletion,
    admitCompletion,
  };
}

function createEmptyGoalState(): StoredGoalState {
  return {
    schemaVersion: GOAL_STORE_SCHEMA_VERSION,
    current: null,
  };
}

function parseStoredGoalState(value: unknown): StoredGoalState {
  if (!isRecord(value)) {
    throw new Error('invalid Goal store');
  }
  if (value.schemaVersion === LEGACY_GOAL_STORE_SCHEMA_VERSION) {
    return {
      schemaVersion: GOAL_STORE_SCHEMA_VERSION,
      current:
        value.current === null
          ? null
          : parseLegacyStoredCurrentGoal(value.current),
    };
  }
  if (value.schemaVersion !== GOAL_STORE_SCHEMA_VERSION) {
    throw new Error('invalid Goal store');
  }
  return {
    schemaVersion: GOAL_STORE_SCHEMA_VERSION,
    current:
      value.current === null ? null : parseStoredCurrentGoal(value.current),
  };
}

function parseStoredCurrentGoal(value: unknown): StoredCurrentGoal {
  if (
    !isRecord(value) ||
    !isGoalSnapshot(value.snapshot) ||
    !isRunExecutionTemplate(value.executionTemplate) ||
    (value.completionRunId !== undefined &&
      (!isString(value.completionRunId) || !isRunId(value.completionRunId))) ||
    !Array.isArray(value.completionAdmissions) ||
    !Array.isArray(value.legacyVerificationAttempts)
  ) {
    throw new Error('invalid current Goal');
  }
  return {
    snapshot: value.snapshot,
    executionTemplate: value.executionTemplate,
    ...(value.completionRunId === undefined
      ? {}
      : { completionRunId: value.completionRunId }),
    completionAdmissions: value.completionAdmissions.map(
      parseStoredCompletionAdmission,
    ),
    legacyVerificationAttempts: value.legacyVerificationAttempts.map(
      parseStoredLegacyVerificationAttempt,
    ),
  };
}

function parseLegacyStoredCurrentGoal(value: unknown): StoredCurrentGoal {
  if (
    !isRecord(value) ||
    !isGoalSnapshot(value.snapshot) ||
    !isRunExecutionTemplate(value.executionTemplate) ||
    (value.verificationRunId !== undefined &&
      (!isString(value.verificationRunId) ||
        !isRunId(value.verificationRunId))) ||
    !Array.isArray(value.verificationAttempts)
  ) {
    throw new Error('invalid legacy current Goal');
  }
  return {
    snapshot: value.snapshot,
    executionTemplate: value.executionTemplate,
    ...(value.verificationRunId === undefined
      ? {}
      : { completionRunId: value.verificationRunId }),
    completionAdmissions: [],
    legacyVerificationAttempts: value.verificationAttempts.map(
      parseStoredLegacyVerificationAttempt,
    ),
  };
}

function parseStoredCompletionAdmission(
  value: unknown,
): StoredGoalCompletionAdmission {
  if (
    !isRecord(value) ||
    !isString(value.runId) ||
    !isRunId(value.runId) ||
    !isTimestamp(value.admittedAt)
  ) {
    throw new Error('invalid Goal completion admission');
  }
  return {
    runId: value.runId,
    admittedAt: value.admittedAt,
  };
}

function parseStoredLegacyVerificationAttempt(
  value: unknown,
): StoredLegacyGoalVerificationAttempt {
  if (
    !isRecord(value) ||
    !isString(value.runId) ||
    !isRunId(value.runId) ||
    !isTimestamp(value.attemptedAt) ||
    !isLegacyGoalVerificationOutcome(value.outcome) ||
    !Array.isArray(value.votes) ||
    !value.votes.every(isLegacyGoalVerificationVoteRecord)
  ) {
    throw new Error('invalid legacy Goal verification attempt');
  }
  return {
    runId: value.runId,
    attemptedAt: value.attemptedAt,
    outcome: value.outcome,
    votes: value.votes,
  };
}

function requireCurrentGoal(
  state: StoredGoalState,
  goalId: string,
): StoredCurrentGoal {
  const current = state.current;
  if (current === null || current.snapshot.goalId !== goalId) {
    throw goalConflict('Goal is not current');
  }
  return current;
}

function isGoalRunState(state: GoalSnapshot['state']): boolean {
  return state === 'working' || state === 'continuing' || state === 'verifying';
}

function isLegacyGoalVerificationOutcome(
  value: unknown,
): value is LegacyGoalVerificationOutcome {
  if (!isRecord(value) || !isString(value.kind)) {
    return false;
  }
  if (value.kind === 'achieved') {
    return hasOnlyKeys(value, ['kind']);
  }
  if (value.kind === 'incomplete') {
    return (
      hasOnlyKeys(value, ['kind', 'unmetRequirements']) &&
      isNonEmptyStringArray(value.unmetRequirements)
    );
  }
  return (
    value.kind === 'unavailable' &&
    hasOnlyKeys(value, ['kind', 'message']) &&
    isNonBlankString(value.message)
  );
}

function isLegacyGoalVerificationVoteRecord(
  value: unknown,
): value is LegacyGoalVerificationVoteRecord {
  if (!isRecord(value) || !isString(value.verdict)) {
    return false;
  }
  if (value.verdict === 'achieved') {
    return hasOnlyKeys(value, ['verdict']);
  }
  if (value.verdict === 'not_achieved') {
    return (
      hasOnlyKeys(value, ['verdict', 'unmetRequirements']) &&
      isNonEmptyStringArray(value.unmetRequirements)
    );
  }
  return (
    value.verdict === 'unavailable' &&
    hasOnlyKeys(value, ['verdict', 'reason']) &&
    isNonBlankString(value.reason)
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isNonBlankString)
  );
}

function isNonBlankString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function goalConflict(message: string): Error & { code: 'conflict' } {
  return Object.assign(new Error(message), { code: 'conflict' as const });
}
