import { isThreadId, type ThreadId } from './ids.js';
import {
  isCanonicalIsoTimestamp,
  isRecord,
  isString,
} from './wire-value-guards.js';

export const GOAL_STATES = [
  'working',
  'continuing',
  'verifying',
  'completed',
  'paused',
  'verification_unavailable',
] as const;

export type GoalState = (typeof GOAL_STATES)[number];

export interface GoalRef {
  goalId: string;
}

export interface GoalSnapshot extends GoalRef {
  threadId: ThreadId;
  objective: string;
  state: GoalState;
  createdAt: string;
  updatedAt: string;
}

interface GoalCommandTarget extends GoalRef {
  threadId: ThreadId;
}

export type GoalCommand =
  | (GoalCommandTarget & { kind: 'pause' })
  | (GoalCommandTarget & { kind: 'resume' })
  | (GoalCommandTarget & { kind: 'cancel' });

export function isGoalState(value: unknown): value is GoalState {
  return (GOAL_STATES as readonly unknown[]).includes(value);
}

export function isGoalRef(value: unknown): value is GoalRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['goalId']) &&
    isNonBlankString(value.goalId)
  );
}

export function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'goalId',
      'threadId',
      'objective',
      'state',
      'createdAt',
      'updatedAt',
    ]) &&
    isNonBlankString(value.goalId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isNonBlankString(value.objective) &&
    isGoalState(value.state) &&
    isCanonicalIsoTimestamp(value.createdAt) &&
    isCanonicalIsoTimestamp(value.updatedAt)
  );
}

export function isGoalCommand(value: unknown): value is GoalCommand {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'threadId', 'goalId']) &&
    (value.kind === 'pause' ||
      value.kind === 'resume' ||
      value.kind === 'cancel') &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isNonBlankString(value.goalId)
  );
}

function isNonBlankString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
