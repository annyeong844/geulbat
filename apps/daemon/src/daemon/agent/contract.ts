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
import {
  isAgentChildTerminalState as isProtocolAgentChildTerminalState,
  type AgentChildTerminalState,
  type RunUsageTotals,
  type SideEffectLevel,
  type ThreadStatePersistenceFailureDiagnostic,
} from '@geulbat/protocol/run-events';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunSubagentModelRouting } from '@geulbat/protocol/run-contract';
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
  type ProviderNativeCompactionOutputItem,
  type ProviderTransitionCompactionEntryData,
  type SummaryCompactionEntryData,
  type ThreadMessage,
  type ThreadMessageInput,
  type ThreadSummary,
} from '@geulbat/protocol/threads';

export type {
  ArtifactRef,
  BudgetProfile,
  PermissionMode,
  ProviderNativeCompactionEntryData,
  ProviderNativeCompactionOutputItem,
  ProviderTransitionCompactionEntryData,
  RunId,
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
