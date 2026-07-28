import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assertThreadId, isRunId, type ThreadId } from '@geulbat/protocol/ids';
import {
  isApprovedPlanRef,
  isPlanDraftV1,
  isPlanningWorkflowSnapshot,
  type ApprovedPlanRef,
  type PlanDraftV1,
  type PlanningWorkflowSnapshot,
} from '@geulbat/protocol/planning-workflow';
import type { PlanApprovalRecord } from '../planning-approval.js';
import {
  loadPlanState,
  savePlanState,
  type PlanItem,
} from '../plan-state-store.js';
import { isRecord } from '../runtime-json.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage, isNotFoundError } from '../utils/error.js';
import {
  isRunExecutionTemplate,
  type RunExecutionTemplate,
} from './run-execution-template.js';

/**
 * 계획 워크플로 상태의 내구 저장. 스레드당 JSON 한 파일, 스키마 마이그레이션,
 * 승인된 초안의 plan state 발행, 그리고 발행 중 크래시의 복구가 여기 있다.
 *
 * 워크플로 의미론(상태 전이·충돌 판정·실행 수명)은 store가 소유한다. 이
 * 모듈은 "지금 디스크에 무엇이 있고, 어떻게 안전하게 바꾸는가"만 안다.
 */

const PLANNING_WORKFLOW_SCHEMA_VERSION = 2;
const LEGACY_PLANNING_WORKFLOW_SCHEMA_VERSION = 1;

interface StoredCurrentWorkflow {
  snapshot: PlanningWorkflowSnapshot;
  executionTemplate: RunExecutionTemplate;
}

export interface StoredApproval {
  record: PlanApprovalRecord;
  draft: PlanDraftV1;
  executionTemplate: RunExecutionTemplate;
}

export interface StoredPlanningWorkflowState {
  schemaVersion: typeof PLANNING_WORKFLOW_SCHEMA_VERSION;
  current: StoredCurrentWorkflow | null;
  approvals: StoredApproval[];
}

interface PlanningWorkflowPersistence {
  /** 스레드의 상태 파일 경로 — 변경 직렬화의 키이기도 하다. */
  workflowPath(threadId: ThreadId): string;
  readState(threadId: ThreadId): Promise<StoredPlanningWorkflowState>;
  writeState(
    threadId: ThreadId,
    state: StoredPlanningWorkflowState,
  ): Promise<void>;
  publishApprovedDraft(
    threadId: ThreadId,
    current: StoredCurrentWorkflow,
  ): Promise<void>;
  /** 발행 직전에 죽은 기록을 발행 완료 상태로 끌어올린다. */
  recoverPendingPublish(
    threadId: ThreadId,
    state: StoredPlanningWorkflowState,
  ): Promise<StoredPlanningWorkflowState>;
  readRecoveredState(threadId: ThreadId): Promise<StoredPlanningWorkflowState>;
}

export function createPlanningWorkflowPersistence(args: {
  stateRoot: string;
  now: () => string;
}): PlanningWorkflowPersistence {
  const { now, stateRoot } = args;
  const root = join(stateRoot, '.geulbat', 'planning-workflows');

  return {
    publishApprovedDraft,
    readRecoveredState,
    readState,
    recoverPendingPublish,
    workflowPath,
    writeState,
  };

  function workflowPath(threadId: ThreadId): string {
    return join(root, `${assertThreadId(threadId)}.json`);
  }

  async function readState(
    threadId: ThreadId,
  ): Promise<StoredPlanningWorkflowState> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(workflowPath(threadId), 'utf8'),
      );
      const state = parseStoredState(raw);
      if (
        isRecord(raw) &&
        raw.schemaVersion === LEGACY_PLANNING_WORKFLOW_SCHEMA_VERSION
      ) {
        await writeState(threadId, state);
      }
      return state;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return createEmptyState();
      }
      throw new Error(
        `invalid planning workflow state: ${getErrorMessage(error)}`,
      );
    }
  }

  async function writeState(
    threadId: ThreadId,
    state: StoredPlanningWorkflowState,
  ): Promise<void> {
    await writeTextFileAtomically(
      workflowPath(threadId),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  async function publishApprovedDraft(
    threadId: ThreadId,
    current: StoredCurrentWorkflow,
  ): Promise<void> {
    const snapshot = requireDraftSnapshot(current.snapshot);
    await loadPlanState(stateRoot, threadId);
    const createdAt = Date.parse(snapshot.updatedAt);
    const items: PlanItem[] = snapshot.draft.steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: 'pending',
      createdAt,
    }));
    await savePlanState(stateRoot, threadId, {
      nextId: items.length + 1,
      items,
      execution: {
        approvedPlanRef: snapshotRef(snapshot),
      },
    });
  }

  async function recoverPendingPublish(
    threadId: ThreadId,
    state: StoredPlanningWorkflowState,
  ): Promise<StoredPlanningWorkflowState> {
    const current = state.current;
    if (current?.snapshot.state !== 'approved_pending_publish') {
      return state;
    }
    await publishApprovedDraft(threadId, current);
    const updatedAt = now();
    const recovered: StoredPlanningWorkflowState = {
      ...state,
      current: {
        ...current,
        snapshot: {
          ...current.snapshot,
          state: 'approved',
          updatedAt,
        },
      },
    };
    await writeState(threadId, recovered);
    return recovered;
  }

  async function readRecoveredState(
    threadId: ThreadId,
  ): Promise<StoredPlanningWorkflowState> {
    return await recoverPendingPublish(threadId, await readState(threadId));
  }
}

export function snapshotRef(
  snapshot: Extract<PlanningWorkflowSnapshot, { planId: string }>,
): ApprovedPlanRef {
  return {
    workflowId: snapshot.workflowId,
    planId: snapshot.planId,
    revision: snapshot.revision,
    digest: snapshot.digest,
  };
}

function createEmptyState(): StoredPlanningWorkflowState {
  return {
    schemaVersion: PLANNING_WORKFLOW_SCHEMA_VERSION,
    current: null,
    approvals: [],
  };
}

function parseStoredState(value: unknown): StoredPlanningWorkflowState {
  const normalized = migrateStoredPlanningWorkflowV1(value);
  if (
    !isRecord(normalized) ||
    normalized.schemaVersion !== PLANNING_WORKFLOW_SCHEMA_VERSION ||
    !Array.isArray(normalized.approvals)
  ) {
    throw new Error('invalid planning workflow store');
  }
  return {
    schemaVersion: PLANNING_WORKFLOW_SCHEMA_VERSION,
    current:
      normalized.current === null
        ? null
        : parseStoredCurrent(normalized.current),
    approvals: normalized.approvals.map(parseStoredApproval),
  };
}

function migrateStoredPlanningWorkflowV1(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LEGACY_PLANNING_WORKFLOW_SCHEMA_VERSION
  ) {
    return value;
  }
  if (value.current === null) {
    return {
      ...value,
      schemaVersion: PLANNING_WORKFLOW_SCHEMA_VERSION,
    };
  }
  if (!isRecord(value.current) || !isRecord(value.current.snapshot)) {
    throw new Error('invalid legacy planning workflow store');
  }
  // v1 predates the independent interrogation-depth axis. Its behaviour is
  // exactly the v2 standard depth, so migration names that semantic mapping
  // once and immediately rewrites the durable record as v2.
  return {
    ...value,
    schemaVersion: PLANNING_WORKFLOW_SCHEMA_VERSION,
    current: {
      ...value.current,
      snapshot: {
        ...value.current.snapshot,
        depth: 'standard',
      },
    },
  };
}

function parseStoredCurrent(value: unknown): StoredCurrentWorkflow {
  if (
    !isRecord(value) ||
    !isPlanningWorkflowSnapshot(value.snapshot) ||
    !isRunExecutionTemplate(value.executionTemplate)
  ) {
    throw new Error('invalid current planning workflow');
  }
  return {
    snapshot: value.snapshot,
    executionTemplate: value.executionTemplate,
  };
}

function parseStoredApproval(value: unknown): StoredApproval {
  const approvedPlanRef =
    isRecord(value) && isRecord(value.record)
      ? {
          workflowId: value.record.workflowId,
          planId: value.record.planId,
          revision: value.record.revision,
          digest: value.record.digest,
        }
      : undefined;
  if (
    !isRecord(value) ||
    !isRecord(value.record) ||
    !isApprovedPlanRef(approvedPlanRef) ||
    !isStringField(value.record.proposalRunId) ||
    !isRunId(value.record.proposalRunId) ||
    !isStringField(value.record.decidedAt) ||
    (value.record.executionRunId !== undefined &&
      (!isStringField(value.record.executionRunId) ||
        !isRunId(value.record.executionRunId))) ||
    !isPlanDraftV1(value.draft) ||
    !isRunExecutionTemplate(value.executionTemplate)
  ) {
    throw new Error('invalid planning approval record');
  }
  return {
    record: {
      ...approvedPlanRef,
      proposalRunId: value.record.proposalRunId,
      ...(value.record.executionRunId === undefined
        ? {}
        : { executionRunId: value.record.executionRunId }),
      decidedAt: value.record.decidedAt,
    },
    draft: value.draft,
    executionTemplate: value.executionTemplate,
  };
}

function requireDraftSnapshot(
  snapshot: PlanningWorkflowSnapshot,
): Extract<PlanningWorkflowSnapshot, { state: 'approved_pending_publish' }> {
  if (snapshot.state !== 'approved_pending_publish') {
    throw new Error('planning workflow is not pending publication');
  }
  return snapshot;
}

function isStringField(value: unknown): value is string {
  return typeof value === 'string';
}
