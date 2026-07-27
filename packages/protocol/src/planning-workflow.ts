import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import {
  hasOnlyKeys,
  isCanonicalIsoTimestamp,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';

export const PLAN_MODE_INTENSITIES = ['quiet', 'visual'] as const;
export type PlanModeIntensity = (typeof PLAN_MODE_INTENSITIES)[number];

export const PLAN_MODE_DEPTHS = ['standard', 'deep'] as const;
export type PlanModeDepth = (typeof PLAN_MODE_DEPTHS)[number];

export interface PlanDraftStepV1 {
  id: string;
  text: string;
  acceptanceCriteria: string[];
}

export interface PlanDraftDecisionV1 {
  text: string;
  settledBy: 'user' | 'agent';
}

export interface PlanDraftV1 {
  schemaVersion: 'plan_draft_v1';
  outcome: string;
  steps: PlanDraftStepV1[];
  decisions: PlanDraftDecisionV1[];
  assumptions: string[];
  openQuestions: string[];
}

export type PlanDigest = `sha256:${string}`;

export interface ApprovedPlanRef {
  workflowId: string;
  planId: string;
  revision: number;
  digest: PlanDigest;
}

export type PlanRenderingStamp = ApprovedPlanRef;

export function isSamePlanRenderingStamp(
  left: PlanRenderingStamp,
  right: PlanRenderingStamp,
): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.planId === right.planId &&
    left.revision === right.revision &&
    left.digest === right.digest
  );
}

interface PlanningWorkflowSnapshotBase {
  workflowId: string;
  threadId: ThreadId;
  intensity: PlanModeIntensity;
  depth: PlanModeDepth;
  createdAt: string;
  updatedAt: string;
}

interface PlanningWorkflowDraftSnapshot
  extends PlanningWorkflowSnapshotBase, ApprovedPlanRef {
  draft: PlanDraftV1;
  proposalRunId: RunId;
}

interface PlanningWorkflowExecutionSnapshot extends PlanningWorkflowDraftSnapshot {
  executionRunId: RunId;
}

export type PlanningWorkflowSnapshot =
  | (PlanningWorkflowSnapshotBase & {
      state: 'collecting';
      planId?: string;
      revision?: number;
      revisionFeedback?: string;
    })
  | (PlanningWorkflowDraftSnapshot & { state: 'awaiting_approval' })
  | (PlanningWorkflowDraftSnapshot & { state: 'approved_pending_publish' })
  | (PlanningWorkflowDraftSnapshot & { state: 'approved' })
  | (PlanningWorkflowExecutionSnapshot & { state: 'executing' })
  | (PlanningWorkflowExecutionSnapshot & { state: 'completed' })
  | (PlanningWorkflowExecutionSnapshot & { state: 'execution_failed' });

interface PlanWorkflowCommandTarget extends ApprovedPlanRef {
  threadId: ThreadId;
}

export type PlanWorkflowCommand =
  | (PlanWorkflowCommandTarget & { kind: 'approve' })
  | (PlanWorkflowCommandTarget & {
      kind: 'request_revision';
      feedback?: string;
    })
  | (PlanWorkflowCommandTarget & { kind: 'explain_visual' })
  | (PlanWorkflowCommandTarget & { kind: 'retry_execution' })
  | {
      kind: 'cancel';
      threadId: ThreadId;
      workflowId: string;
      planId?: string;
      revision?: number;
    };

export function isPlanModeIntensity(
  value: unknown,
): value is PlanModeIntensity {
  return (PLAN_MODE_INTENSITIES as readonly unknown[]).includes(value);
}

export function isPlanModeDepth(value: unknown): value is PlanModeDepth {
  return (PLAN_MODE_DEPTHS as readonly unknown[]).includes(value);
}

export function isPlanDraftV1(value: unknown): value is PlanDraftV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'outcome',
      'steps',
      'decisions',
      'assumptions',
      'openQuestions',
    ]) ||
    value.schemaVersion !== 'plan_draft_v1' ||
    !isNonBlankString(value.outcome) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    !value.steps.every(isPlanDraftStepV1) ||
    new Set(value.steps.map((step) => step.id)).size !== value.steps.length ||
    !Array.isArray(value.decisions) ||
    !value.decisions.every(isPlanDraftDecisionV1) ||
    !isStringArray(value.assumptions) ||
    !isStringArray(value.openQuestions)
  ) {
    return false;
  }
  return true;
}

export function isApprovedPlanRef(value: unknown): value is ApprovedPlanRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['workflowId', 'planId', 'revision', 'digest']) &&
    isNonBlankString(value.workflowId) &&
    isNonBlankString(value.planId) &&
    isPositiveInteger(value.revision) &&
    isPlanDigest(value.digest)
  );
}

export function isPlanningWorkflowSnapshot(
  value: unknown,
): value is PlanningWorkflowSnapshot {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.workflowId) ||
    !isString(value.threadId) ||
    !isThreadId(value.threadId) ||
    !isPlanModeIntensity(value.intensity) ||
    !isPlanModeDepth(value.depth) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.updatedAt)
  ) {
    return false;
  }
  if (value.state === 'collecting') {
    return (
      hasOnlyKeys(value, [
        'workflowId',
        'threadId',
        'intensity',
        'depth',
        'createdAt',
        'updatedAt',
        'state',
        'planId',
        'revision',
        'revisionFeedback',
      ]) &&
      (value.planId === undefined || isNonBlankString(value.planId)) &&
      (value.revision === undefined || isPositiveInteger(value.revision)) &&
      (value.revisionFeedback === undefined || isString(value.revisionFeedback))
    );
  }
  if (
    value.state !== 'awaiting_approval' &&
    value.state !== 'approved_pending_publish' &&
    value.state !== 'approved' &&
    value.state !== 'executing' &&
    value.state !== 'completed' &&
    value.state !== 'execution_failed'
  ) {
    return false;
  }
  const executionState =
    value.state === 'executing' ||
    value.state === 'completed' ||
    value.state === 'execution_failed';
  if (
    !hasOnlyKeys(value, [
      'workflowId',
      'threadId',
      'intensity',
      'depth',
      'createdAt',
      'updatedAt',
      'state',
      'planId',
      'revision',
      'digest',
      'draft',
      'proposalRunId',
      ...(executionState ? ['executionRunId'] : []),
    ])
  ) {
    return false;
  }
  if (
    !isApprovedPlanFields(value) ||
    !isPlanDraftV1(value.draft) ||
    !isString(value.proposalRunId) ||
    !isRunId(value.proposalRunId)
  ) {
    return false;
  }
  return executionState
    ? isString(value.executionRunId) && isRunId(value.executionRunId)
    : value.executionRunId === undefined;
}

export function isPlanWorkflowCommand(
  value: unknown,
): value is PlanWorkflowCommand {
  if (
    !isRecord(value) ||
    !isString(value.threadId) ||
    !isThreadId(value.threadId) ||
    !isNonBlankString(value.workflowId) ||
    !isString(value.kind)
  ) {
    return false;
  }
  if (value.kind === 'cancel') {
    return (
      hasOnlyKeys(value, [
        'kind',
        'threadId',
        'workflowId',
        'planId',
        'revision',
      ]) &&
      (value.planId === undefined || isNonBlankString(value.planId)) &&
      (value.revision === undefined || isPositiveInteger(value.revision))
    );
  }
  if (
    value.kind !== 'approve' &&
    value.kind !== 'request_revision' &&
    value.kind !== 'explain_visual' &&
    value.kind !== 'retry_execution'
  ) {
    return false;
  }
  const allowedKeys =
    value.kind === 'request_revision'
      ? [
          'kind',
          'threadId',
          'workflowId',
          'planId',
          'revision',
          'digest',
          'feedback',
        ]
      : ['kind', 'threadId', 'workflowId', 'planId', 'revision', 'digest'];
  return (
    hasOnlyKeys(value, allowedKeys) &&
    isApprovedPlanFields(value) &&
    (value.feedback === undefined || isString(value.feedback))
  );
}

function isPlanDraftStepV1(value: unknown): value is PlanDraftStepV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'text', 'acceptanceCriteria']) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.text) &&
    isStringArray(value.acceptanceCriteria)
  );
}

function isPlanDraftDecisionV1(value: unknown): value is PlanDraftDecisionV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['text', 'settledBy']) &&
    isNonBlankString(value.text) &&
    (value.settledBy === 'user' || value.settledBy === 'agent')
  );
}

function isApprovedPlanFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ApprovedPlanRef {
  return (
    isNonBlankString(value.workflowId) &&
    isNonBlankString(value.planId) &&
    isPositiveInteger(value.revision) &&
    isPlanDigest(value.digest)
  );
}

function isPlanDigest(value: unknown): value is PlanDigest {
  return isString(value) && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNonBlankString(value: unknown): value is string {
  return isString(value) && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}
