import type { RunId } from '@geulbat/protocol/ids';
import type { ApprovedPlanRef } from '@geulbat/protocol/planning-workflow';

export const PLAN_APPROVAL_REQUIRED = 'PLAN_APPROVAL_REQUIRED';
export const PLAN_REVISION_APPROVAL_REQUIRED =
  'PLAN_REVISION_APPROVAL_REQUIRED';

export interface PlanApprovalRecord extends ApprovedPlanRef {
  proposalRunId: RunId;
  executionRunId?: RunId;
  decidedAt: string;
}
