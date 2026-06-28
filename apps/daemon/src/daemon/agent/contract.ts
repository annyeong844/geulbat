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
  type SideEffectLevel,
  type ThreadStatePersistenceFailureDiagnostic,
} from '@geulbat/protocol/run-events';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import {
  readArtifactRefsFromMetadata as readProtocolArtifactRefsFromMetadata,
  type ThreadMessageMetadata,
} from '@geulbat/protocol/thread-metadata';
import type {
  ThreadMessage,
  ThreadMessageInput,
  ThreadSummary,
} from '@geulbat/protocol/threads';

export type {
  AgentChildTerminalState,
  ArtifactRef,
  PermissionMode,
  RunId,
  SideEffectLevel,
  ThreadArtifactVersion,
  ThreadId,
  ThreadMessage,
  ThreadMessageInput,
  ThreadMessageMetadata,
  ThreadStatePersistenceFailureDiagnostic,
  ThreadSummary,
};

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
