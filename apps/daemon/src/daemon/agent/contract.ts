import {
  ARTIFACT_START_PREFIX,
  createArtifactRefKey as createProtocolArtifactRefKey,
  type ArtifactRef,
  type ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import {
  assertRunId as assertProtocolRunId,
  assertThreadId as assertProtocolThreadId,
  isRunId as isProtocolRunId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import type { GoalSnapshot } from '@geulbat/protocol/goal';
import type {
  RunUsageTotals,
  SideEffectLevel,
  ThreadStatePersistenceFailureDiagnostic,
} from '@geulbat/protocol/run-events';
import {
  isAgentChildTerminalState as isProtocolAgentChildTerminalState,
  type AgentChildTerminalState,
} from '@geulbat/protocol/subagent-terminal';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import {
  resolveRunModelDescriptor as resolveProtocolRunModelDescriptor,
  type RunProviderTransitionRecovery,
  type RunServiceTier,
  type RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type {
  ApprovedPlanRef,
  PlanDraftV1,
  PlanModeDepth,
  PlanModeIntensity,
  PlanRenderingStamp,
} from '@geulbat/protocol/planning-workflow';
import {
  readArtifactRefsFromMetadata as readProtocolArtifactRefsFromMetadata,
  type ThreadMessageAttachment,
  type ThreadMessageMetadata,
} from '@geulbat/protocol/thread-metadata';
import {
  isProviderNativeCompactionEntryData as isProtocolProviderNativeCompactionEntryData,
  isProviderTransitionCompactionEntryData as isProtocolProviderTransitionCompactionEntryData,
  type BudgetProfile,
  type ProviderNativeCompactionEntryData,
  type ProviderNativeCompactionEvidencePage,
  type ProviderNativeCompactionEvidenceRef,
  type ProviderNativeCompactionOutputItem,
  type ProviderTransitionCompactionEntryData,
  type SummaryCompactionEntryData,
  type ThreadMessage,
  type ThreadMessageInput,
  type ThreadSummary,
} from '@geulbat/protocol/threads';

export type {
  ArtifactRef,
  ApprovedPlanRef,
  BudgetProfile,
  GoalSnapshot,
  PlanDraftV1,
  PlanModeDepth,
  PlanModeIntensity,
  PlanRenderingStamp,
  PermissionMode,
  ProviderNativeCompactionEntryData,
  ProviderNativeCompactionEvidencePage,
  ProviderNativeCompactionEvidenceRef,
  ProviderNativeCompactionOutputItem,
  ProviderTransitionCompactionEntryData,
  RunId,
  RunProviderTransitionRecovery,
  RunServiceTier,
  RunSubagentModelRouting,
  RunUsageTotals,
  SideEffectLevel,
  SummaryCompactionEntryData,
  ThreadArtifactVersion,
  ThreadId,
  ThreadMessageAttachment,
  ThreadMessage,
  ThreadMessageInput,
  ThreadMessageMetadata,
  ThreadStatePersistenceFailureDiagnostic,
  ThreadSummary,
};

export function isAgentProviderNativeCompactionEntryData(
  value: unknown,
): value is ProviderNativeCompactionEntryData {
  return isProtocolProviderNativeCompactionEntryData(value);
}

export function isAgentProviderTransitionCompactionEntryData(
  value: unknown,
): value is ProviderTransitionCompactionEntryData {
  return isProtocolProviderTransitionCompactionEntryData(value);
}

export function resolveAgentRunModelDescriptor(
  modelId: RunProviderTransitionRecovery['sourceModelId'],
) {
  return resolveProtocolRunModelDescriptor(modelId);
}

export const AGENT_ARTIFACT_START_PREFIX = ARTIFACT_START_PREFIX;

export function assertAgentRunId(runId: string): RunId {
  return assertProtocolRunId(runId);
}

export function assertAgentThreadId(threadId: string): ThreadId {
  return assertProtocolThreadId(threadId);
}

export function isAgentRunId(runId: string): runId is RunId {
  return isProtocolRunId(runId);
}

export function isAgentTerminalRunStatus(
  status: unknown,
): status is AgentChildTerminalState {
  return isProtocolAgentChildTerminalState(status);
}

export function createAgentArtifactRefKey(ref: ArtifactRef): string {
  return createProtocolArtifactRefKey(ref);
}

export function readAgentArtifactRefsFromMetadata(
  metadata: ThreadMessage['metadata'],
): ArtifactRef[] {
  return readProtocolArtifactRefsFromMetadata(metadata);
}
