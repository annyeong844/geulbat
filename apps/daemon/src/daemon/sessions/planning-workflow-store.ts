import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import {
  assertRunId,
  assertThreadId,
  isRunId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  isApprovedPlanRef,
  isPlanDraftV1,
  isPlanningWorkflowSnapshot,
  type ApprovedPlanRef,
  type PlanDraftV1,
  type PlanModeDepth,
  type PlanModeIntensity,
  type PlanningWorkflowSnapshot,
  type PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';
import {
  PLAN_APPROVAL_REQUIRED,
  PLAN_REVISION_APPROVAL_REQUIRED,
  type PlanApprovalRecord,
} from '../planning-approval.js';
import { isRecord } from '../runtime-json.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage, isNotFoundError } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import {
  loadPlanState,
  savePlanState,
  type PlanItem,
} from '../plan-state-store.js';
import {
  isRunExecutionTemplate,
  type RunExecutionTemplate,
} from './run-execution-template.js';

const PLANNING_WORKFLOW_SCHEMA_VERSION = 2;
const LEGACY_PLANNING_WORKFLOW_SCHEMA_VERSION = 1;

type PlanningExecutionTemplate = RunExecutionTemplate;

interface StoredCurrentWorkflow {
  snapshot: PlanningWorkflowSnapshot;
  executionTemplate: PlanningExecutionTemplate;
}

interface StoredApproval {
  record: PlanApprovalRecord;
  draft: PlanDraftV1;
  executionTemplate: PlanningExecutionTemplate;
}

interface StoredPlanningWorkflowState {
  schemaVersion: typeof PLANNING_WORKFLOW_SCHEMA_VERSION;
  current: StoredCurrentWorkflow | null;
  approvals: StoredApproval[];
}

type PlanExecutionCompletionAssessment =
  | { kind: 'complete' }
  | {
      kind: 'incomplete';
      items: ReadonlyArray<{
        id: string;
        text: string;
        status: 'pending' | 'in_progress';
      }>;
    };

export interface PlanningWorkflowStore {
  readThread(threadId: ThreadId): Promise<PlanningWorkflowSnapshot | null>;
  enterOrResume(args: {
    threadId: ThreadId;
    requested: boolean;
    intensity: PlanModeIntensity | undefined;
    depth: PlanModeDepth | undefined;
    executionTemplate: PlanningExecutionTemplate;
  }): Promise<PlanningWorkflowSnapshot | null>;
  recordPlanRun(args: {
    threadId: ThreadId;
    executionTemplate: PlanningExecutionTemplate;
  }): Promise<PlanningWorkflowSnapshot>;
  propose(args: {
    threadId: ThreadId;
    proposalRunId: RunId;
    draft: PlanDraftV1;
  }): Promise<
    Extract<PlanningWorkflowSnapshot, { state: 'awaiting_approval' }>
  >;
  applyCommand(command: PlanWorkflowCommand): Promise<{
    snapshot: PlanningWorkflowSnapshot | null;
    approvedPlanRef?: ApprovedPlanRef;
    executionTemplate?: PlanningExecutionTemplate;
  }>;
  claimExecution(args: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
  }): Promise<{
    snapshot: PlanningWorkflowSnapshot;
    draft: PlanDraftV1;
  }>;
  readApprovedPlan(args: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
  }): Promise<{
    snapshot: Extract<
      PlanningWorkflowSnapshot,
      {
        state: 'approved' | 'executing' | 'completed' | 'execution_failed';
      }
    >;
    draft: PlanDraftV1;
  }>;
  assessExecutionCompletion(args: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
  }): Promise<PlanExecutionCompletionAssessment>;
  completeExecution(args: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
    ok: boolean;
  }): Promise<PlanningWorkflowSnapshot>;
  readPendingExecution(threadId: ThreadId): Promise<{
    ref: ApprovedPlanRef;
    executionTemplate: PlanningExecutionTemplate;
  } | null>;
  assertPlanUpdateAllowed(
    threadId: ThreadId,
    plan: readonly {
      id?: string;
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }[],
  ): Promise<void>;
}

export function createPlanningWorkflowStore(args: {
  stateRoot: string;
  now?: () => string;
  createId?: () => string;
}): PlanningWorkflowStore {
  const root = join(args.stateRoot, '.geulbat', 'planning-workflows');
  const now = args.now ?? (() => new Date().toISOString());
  const createId = args.createId ?? randomUUID;
  const runMutationSerial = createKeyedSerialRunner();

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
    await loadPlanState(args.stateRoot, threadId);
    const createdAt = Date.parse(snapshot.updatedAt);
    const items: PlanItem[] = snapshot.draft.steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: 'pending',
      createdAt,
    }));
    await savePlanState(args.stateRoot, threadId, {
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

  async function readThread(
    threadId: ThreadId,
  ): Promise<PlanningWorkflowSnapshot | null> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      return (await readState(threadId)).current?.snapshot ?? null;
    });
  }

  async function enterOrResume({
    threadId,
    requested,
    intensity,
    depth,
    executionTemplate,
  }: {
    threadId: ThreadId;
    requested: boolean;
    intensity: PlanModeIntensity | undefined;
    depth: PlanModeDepth | undefined;
    executionTemplate: PlanningExecutionTemplate;
  }): Promise<PlanningWorkflowSnapshot | null> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const previous = await readState(threadId);
      const current = previous.current;
      if (
        current !== null &&
        current.snapshot.state !== 'completed' &&
        current.snapshot.state !== 'execution_failed'
      ) {
        if (
          current.snapshot.state === 'approved' ||
          current.snapshot.state === 'executing'
        ) {
          return current.snapshot;
        }
        const next: StoredPlanningWorkflowState = {
          ...previous,
          current: { ...current, executionTemplate },
        };
        await writeState(threadId, next);
        return next.current?.snapshot ?? null;
      }
      if (!requested) {
        return null;
      }
      if (intensity === undefined) {
        throw planningError(
          PLAN_APPROVAL_REQUIRED,
          'plan intensity is required to create a planning workflow',
        );
      }
      if (depth === undefined) {
        throw planningError(
          PLAN_APPROVAL_REQUIRED,
          'plan depth is required to create a planning workflow',
        );
      }
      const timestamp = now();
      const snapshot: PlanningWorkflowSnapshot = {
        state: 'collecting',
        workflowId: `workflow-${createId()}`,
        threadId,
        intensity,
        depth,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeState(threadId, {
        ...previous,
        current: { snapshot, executionTemplate },
      });
      return snapshot;
    });
  }

  async function recordPlanRun({
    threadId,
    executionTemplate,
  }: {
    threadId: ThreadId;
    executionTemplate: PlanningExecutionTemplate;
  }): Promise<PlanningWorkflowSnapshot> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readState(threadId);
      const current = state.current;
      if (
        current === null ||
        current.snapshot.state === 'approved' ||
        current.snapshot.state === 'executing' ||
        current.snapshot.state === 'completed' ||
        current.snapshot.state === 'execution_failed'
      ) {
        throw planningError(
          PLAN_APPROVAL_REQUIRED,
          'no collecting planning workflow is active for this run',
        );
      }
      const next: StoredPlanningWorkflowState = {
        ...state,
        current: { ...current, executionTemplate },
      };
      await writeState(threadId, next);
      return current.snapshot;
    });
  }

  async function propose({
    threadId,
    proposalRunId,
    draft,
  }: {
    threadId: ThreadId;
    proposalRunId: RunId;
    draft: PlanDraftV1;
  }): Promise<
    Extract<PlanningWorkflowSnapshot, { state: 'awaiting_approval' }>
  > {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readState(threadId);
      const current = state.current;
      if (current?.snapshot.state !== 'collecting') {
        throw planningError(
          PLAN_APPROVAL_REQUIRED,
          'a plan can be proposed only while the workflow is collecting',
        );
      }
      const planId = current.snapshot.planId ?? `plan-${createId()}`;
      const revision = (current.snapshot.revision ?? 0) + 1;
      const timestamp = now();
      const snapshot: Extract<
        PlanningWorkflowSnapshot,
        { state: 'awaiting_approval' }
      > = {
        state: 'awaiting_approval',
        workflowId: current.snapshot.workflowId,
        threadId,
        intensity: current.snapshot.intensity,
        depth: current.snapshot.depth,
        planId,
        revision,
        digest: `sha256:${sha256StableJson(draft)}`,
        draft,
        proposalRunId: assertRunId(proposalRunId),
        createdAt: current.snapshot.createdAt,
        updatedAt: timestamp,
      };
      await writeState(threadId, {
        ...state,
        current: { ...current, snapshot },
      });
      return snapshot;
    });
  }

  async function applyCommand(command: PlanWorkflowCommand): Promise<{
    snapshot: PlanningWorkflowSnapshot | null;
    approvedPlanRef?: ApprovedPlanRef;
    executionTemplate?: PlanningExecutionTemplate;
  }> {
    const threadId = command.threadId;
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readState(threadId);
      const current = state.current;
      if (command.kind === 'cancel') {
        if (
          current === null ||
          current.snapshot.workflowId !== command.workflowId
        ) {
          throw planningConflict('planning workflow is not current');
        }
        if (
          current.snapshot.state === 'executing' ||
          current.snapshot.state === 'completed' ||
          current.snapshot.state === 'execution_failed'
        ) {
          throw planningConflict('execution workflow cannot be cancelled');
        }
        await writeState(threadId, { ...state, current: null });
        return { snapshot: null };
      }

      const approvedRef = commandRef(command);
      if (command.kind === 'retry_execution') {
        if (
          current !== null &&
          (current.snapshot.state === 'approved' ||
            current.snapshot.state === 'executing' ||
            current.snapshot.state === 'completed') &&
          refsEqual(current.snapshot, approvedRef)
        ) {
          return {
            snapshot: current.snapshot,
            approvedPlanRef: approvedRef,
          };
        }
        if (
          current?.snapshot.state !== 'execution_failed' ||
          !refsEqual(current.snapshot, approvedRef)
        ) {
          throw planningConflict(
            'only the current failed plan execution can be retried',
          );
        }
        const snapshot: PlanningWorkflowSnapshot = {
          state: 'approved',
          workflowId: current.snapshot.workflowId,
          threadId,
          intensity: current.snapshot.intensity,
          depth: current.snapshot.depth,
          planId: current.snapshot.planId,
          revision: current.snapshot.revision,
          digest: current.snapshot.digest,
          draft: current.snapshot.draft,
          proposalRunId: current.snapshot.proposalRunId,
          createdAt: current.snapshot.createdAt,
          updatedAt: now(),
        };
        await writeState(threadId, {
          ...state,
          current: { ...current, snapshot },
        });
        return {
          snapshot,
          approvedPlanRef: approvedRef,
          executionTemplate: current.executionTemplate,
        };
      }
      if (command.kind === 'approve') {
        const idempotent = state.approvals.find((approval) =>
          refsEqual(approval.record, approvedRef),
        );
        if (
          idempotent !== undefined &&
          current?.snapshot.state === 'approved_pending_publish' &&
          refsEqual(current.snapshot, approvedRef)
        ) {
          const recovered = await recoverPendingPublish(threadId, state);
          return {
            snapshot: recovered.current?.snapshot ?? null,
            approvedPlanRef: approvedRef,
            executionTemplate: idempotent.executionTemplate,
          };
        }
        if (
          idempotent !== undefined &&
          (current === null ||
            current.snapshot.state === 'approved' ||
            current.snapshot.state === 'executing' ||
            current.snapshot.state === 'completed' ||
            current.snapshot.state === 'execution_failed')
        ) {
          return {
            snapshot: current?.snapshot ?? null,
            approvedPlanRef: approvedRef,
          };
        }
      }
      if (
        current?.snapshot.state !== 'awaiting_approval' ||
        !refsEqual(current.snapshot, approvedRef)
      ) {
        throw planningConflict('plan revision or digest is no longer current');
      }

      if (command.kind === 'request_revision') {
        const timestamp = now();
        const snapshot: PlanningWorkflowSnapshot = {
          state: 'collecting',
          workflowId: current.snapshot.workflowId,
          threadId,
          intensity: current.snapshot.intensity,
          depth: current.snapshot.depth,
          planId: current.snapshot.planId,
          revision: current.snapshot.revision,
          ...(command.feedback === undefined
            ? {}
            : { revisionFeedback: command.feedback }),
          createdAt: current.snapshot.createdAt,
          updatedAt: timestamp,
        };
        await writeState(threadId, {
          ...state,
          current: { ...current, snapshot },
        });
        return { snapshot, executionTemplate: current.executionTemplate };
      }

      if (command.kind === 'explain_visual') {
        if (current.snapshot.intensity !== 'visual') {
          throw planningConflict(
            'visual explanation is unavailable for a quiet planning workflow',
          );
        }
        return {
          snapshot: current.snapshot,
          executionTemplate: current.executionTemplate,
        };
      }

      const decidedAt = now();
      const approval: StoredApproval = {
        record: {
          ...approvedRef,
          proposalRunId: current.snapshot.proposalRunId,
          decidedAt,
        },
        draft: current.snapshot.draft,
        executionTemplate: current.executionTemplate,
      };
      const pendingSnapshot: PlanningWorkflowSnapshot = {
        ...current.snapshot,
        state: 'approved_pending_publish',
        updatedAt: decidedAt,
      };
      const pendingState: StoredPlanningWorkflowState = {
        ...state,
        current: { ...current, snapshot: pendingSnapshot },
        approvals: [...state.approvals, approval],
      };
      await writeState(threadId, pendingState);
      const pendingCurrent = pendingState.current;
      if (pendingCurrent === null) {
        throw new Error('approved plan publication state is missing');
      }
      await publishApprovedDraft(threadId, pendingCurrent);
      const approvedSnapshot: PlanningWorkflowSnapshot = {
        ...pendingSnapshot,
        state: 'approved',
        updatedAt: now(),
      };
      await writeState(threadId, {
        ...pendingState,
        current: { ...pendingCurrent, snapshot: approvedSnapshot },
      });
      return {
        snapshot: approvedSnapshot,
        approvedPlanRef: approvedRef,
        executionTemplate: current.executionTemplate,
      };
    });
  }

  async function claimExecution({
    ref,
    threadId,
    executionRunId,
  }: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
  }): Promise<{
    snapshot: PlanningWorkflowSnapshot;
    draft: PlanDraftV1;
  }> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readState(threadId);
      const current = state.current;
      if (current?.snapshot.state === 'executing') {
        if (
          refsEqual(current.snapshot, ref) &&
          current.snapshot.executionRunId === executionRunId
        ) {
          await bindPlanExecution(threadId, ref, executionRunId);
          return { snapshot: current.snapshot, draft: current.snapshot.draft };
        }
        throw planningConflict('approved plan execution is already claimed');
      }
      if (
        current?.snapshot.state !== 'approved' ||
        !refsEqual(current.snapshot, ref)
      ) {
        throw planningConflict('approved plan reference is not executable');
      }
      const timestamp = now();
      const snapshot: PlanningWorkflowSnapshot = {
        ...current.snapshot,
        state: 'executing',
        executionRunId: assertRunId(executionRunId),
        updatedAt: timestamp,
      };
      const approvals = state.approvals.map((approval) =>
        refsEqual(approval.record, ref)
          ? {
              ...approval,
              record: {
                ...approval.record,
                executionRunId: assertRunId(executionRunId),
              },
            }
          : approval,
      );
      await writeState(threadId, {
        ...state,
        current: { ...current, snapshot },
        approvals,
      });
      await bindPlanExecution(threadId, ref, executionRunId);
      return { snapshot, draft: snapshot.draft };
    });
  }

  async function bindPlanExecution(
    threadId: ThreadId,
    ref: ApprovedPlanRef,
    executionRunId: RunId,
  ): Promise<void> {
    const plan = await loadPlanState(args.stateRoot, threadId);
    if (
      plan.execution === undefined ||
      !refsEqual(plan.execution.approvedPlanRef, ref)
    ) {
      throw planningConflict(
        'published plan progress does not match the approved plan',
      );
    }
    await savePlanState(args.stateRoot, threadId, {
      ...plan,
      execution: {
        approvedPlanRef: ref,
        executionRunId: assertRunId(executionRunId),
      },
    });
  }

  async function readApprovedPlan({
    ref,
    threadId,
  }: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
  }): Promise<{
    snapshot: Extract<
      PlanningWorkflowSnapshot,
      {
        state: 'approved' | 'executing' | 'completed' | 'execution_failed';
      }
    >;
    draft: PlanDraftV1;
  }> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const current = (await readState(threadId)).current;
      if (
        current === null ||
        (current.snapshot.state !== 'approved' &&
          current.snapshot.state !== 'executing' &&
          current.snapshot.state !== 'completed' &&
          current.snapshot.state !== 'execution_failed') ||
        !refsEqual(current.snapshot, ref)
      ) {
        throw planningConflict('approved plan reference is not current');
      }
      return {
        snapshot: current.snapshot,
        draft: current.snapshot.draft,
      };
    });
  }

  async function assessExecutionCompletion({
    ref,
    threadId,
    executionRunId,
  }: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
  }): Promise<PlanExecutionCompletionAssessment> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const current = (await readState(threadId)).current;
      if (
        current?.snapshot.state !== 'executing' ||
        !refsEqual(current.snapshot, ref) ||
        current.snapshot.executionRunId !== executionRunId
      ) {
        throw planningConflict('plan execution identity does not match');
      }
      const executionSnapshot = current.snapshot;
      const plan = await loadPlanState(args.stateRoot, threadId);
      if (
        plan.execution === undefined ||
        plan.execution.executionRunId !== executionRunId ||
        !refsEqual(plan.execution.approvedPlanRef, ref)
      ) {
        throw planningConflict(
          'plan progress is not bound to this execution run',
        );
      }
      const structureMatches =
        plan.items.length === executionSnapshot.draft.steps.length &&
        plan.items.every((item, index) => {
          const approvedStep = executionSnapshot.draft.steps[index];
          return (
            approvedStep !== undefined &&
            item.id === approvedStep.id &&
            item.text === approvedStep.text
          );
        });
      if (!structureMatches) {
        throw planningConflict(
          'published plan progress does not match the approved plan',
        );
      }
      const items = plan.items.flatMap(({ id, text, status }) =>
        status === 'completed' ? [] : [{ id, text, status }],
      );
      return items.length === 0
        ? { kind: 'complete' }
        : { kind: 'incomplete', items };
    });
  }

  async function completeExecution({
    ref,
    threadId,
    executionRunId,
    ok,
  }: {
    ref: ApprovedPlanRef;
    threadId: ThreadId;
    executionRunId: RunId;
    ok: boolean;
  }): Promise<PlanningWorkflowSnapshot> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readState(threadId);
      const current = state.current;
      if (
        current === null ||
        (current.snapshot.state !== 'executing' &&
          current.snapshot.state !== 'completed' &&
          current.snapshot.state !== 'execution_failed') ||
        !refsEqual(current.snapshot, ref) ||
        current.snapshot.executionRunId !== executionRunId
      ) {
        throw planningConflict('plan execution identity does not match');
      }
      if (
        current.snapshot.state === 'completed' ||
        current.snapshot.state === 'execution_failed'
      ) {
        if ((current.snapshot.state === 'completed') === ok) {
          return current.snapshot;
        }
        throw planningConflict('plan execution already settled differently');
      }
      if (current.snapshot.state !== 'executing') {
        throw planningConflict('plan execution is not active');
      }
      const snapshot: PlanningWorkflowSnapshot = {
        ...current.snapshot,
        state: ok ? 'completed' : 'execution_failed',
        updatedAt: now(),
      };
      await writeState(threadId, {
        ...state,
        current: { ...current, snapshot },
      });
      return snapshot;
    });
  }

  async function readPendingExecution(threadId: ThreadId): Promise<{
    ref: ApprovedPlanRef;
    executionTemplate: PlanningExecutionTemplate;
  } | null> {
    const path = workflowPath(threadId);
    return await runMutationSerial(path, async () => {
      const state = await readRecoveredState(threadId);
      const current = state.current;
      if (current?.snapshot.state !== 'approved') {
        return null;
      }
      return {
        ref: snapshotRef(current.snapshot),
        executionTemplate: current.executionTemplate,
      };
    });
  }

  async function assertPlanUpdateAllowed(
    threadId: ThreadId,
    plan: readonly {
      id?: string;
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }[],
  ): Promise<void> {
    const path = workflowPath(threadId);
    await runMutationSerial(path, async () => {
      const current = (await readState(threadId)).current?.snapshot;
      if (current === undefined) {
        return;
      }
      if (
        current.state === 'collecting' ||
        current.state === 'awaiting_approval' ||
        current.state === 'approved_pending_publish'
      ) {
        throw planningError(
          PLAN_APPROVAL_REQUIRED,
          'update_plan cannot publish before exact plan approval',
        );
      }
      if (
        current.state !== 'approved' &&
        current.state !== 'executing' &&
        current.state !== 'completed' &&
        current.state !== 'execution_failed'
      ) {
        return;
      }
      const structureMatches =
        plan.length === current.draft.steps.length &&
        plan.every((step, index) => {
          const approvedStep = current.draft.steps[index];
          return (
            approvedStep !== undefined &&
            step.id === approvedStep.id &&
            step.step === approvedStep.text
          );
        });
      if (!structureMatches) {
        throw planningError(
          PLAN_REVISION_APPROVAL_REQUIRED,
          'published plan structure is immutable; only step statuses may change',
        );
      }
    });
  }

  return {
    readThread,
    enterOrResume,
    recordPlanRun,
    propose,
    applyCommand,
    claimExecution,
    readApprovedPlan,
    assessExecutionCompletion,
    completeExecution,
    readPendingExecution,
    assertPlanUpdateAllowed,
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

function commandRef(
  command: Exclude<PlanWorkflowCommand, { kind: 'cancel' }>,
): ApprovedPlanRef {
  return {
    workflowId: command.workflowId,
    planId: command.planId,
    revision: command.revision,
    digest: command.digest,
  };
}

function snapshotRef(
  snapshot: Extract<PlanningWorkflowSnapshot, { planId: string }>,
): ApprovedPlanRef {
  return {
    workflowId: snapshot.workflowId,
    planId: snapshot.planId,
    revision: snapshot.revision,
    digest: snapshot.digest,
  };
}

function refsEqual(left: ApprovedPlanRef, right: ApprovedPlanRef): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.planId === right.planId &&
    left.revision === right.revision &&
    left.digest === right.digest
  );
}

function planningConflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'conflict' });
}

function planningError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function isStringField(value: unknown): value is string {
  return typeof value === 'string';
}
