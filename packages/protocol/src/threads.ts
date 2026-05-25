import {
  isProjectId,
  isThreadId,
  type ProjectId,
  type ThreadId,
} from './ids.js';
import { isRecord } from './runtime-utils.js';
import {
  isThreadArtifactVersion,
  type ThreadArtifactVersion,
} from './artifacts.js';
import {
  isThreadMessageMetadata,
  type ThreadMessageMetadata,
} from './thread-metadata.js';

export const THREAD_MESSAGE_ROLES = [
  'user',
  'assistant',
  'tool_call',
  'tool_result',
] as const;

export type ThreadMessageRole = (typeof THREAD_MESSAGE_ROLES)[number];

export function isThreadMessageRole(
  value: unknown,
): value is ThreadMessageRole {
  return (
    typeof value === 'string' &&
    (THREAD_MESSAGE_ROLES as readonly string[]).includes(value)
  );
}

export interface ThreadSummary {
  threadId: ThreadId;
  projectId: ProjectId;
  title?: string;
  lastUpdated: string;
  messageCount: number;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export interface ThreadDetailResponse {
  threadId: ThreadId;
  projectId: ProjectId;
  snapshotVersion: string;
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  diagnostics?: ThreadDetailDiagnostics;
}

export interface ThreadDeleteResponse {
  ok: true;
  threadId: ThreadId;
  projectId: ProjectId;
}

export interface ThreadMessage {
  role: ThreadMessageRole;
  content: string;
  timestamp: string;
  metadata?: ThreadMessageMetadata;
}

export function isThreadMessage(value: unknown): value is ThreadMessage {
  return (
    isRecord(value) &&
    isThreadMessageRole(value.role) &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'string' &&
    (value.metadata === undefined || isThreadMessageMetadata(value.metadata))
  );
}

export function isThreadSummary(value: unknown): value is ThreadSummary {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId) &&
    (value.title === undefined || typeof value.title === 'string') &&
    typeof value.lastUpdated === 'string' &&
    typeof value.messageCount === 'number' &&
    Number.isFinite(value.messageCount)
  );
}

export function isThreadListResponse(
  value: unknown,
): value is ThreadListResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.threads) &&
    value.threads.every(isThreadSummary)
  );
}

export function isThreadDetailDiagnostics(
  value: unknown,
): value is ThreadDetailDiagnostics {
  return (
    isRecord(value) &&
    typeof value.unlinkedPersistedArtifactCount === 'number' &&
    Number.isInteger(value.unlinkedPersistedArtifactCount) &&
    value.unlinkedPersistedArtifactCount >= 0 &&
    typeof value.missingLinkedArtifactCount === 'number' &&
    Number.isInteger(value.missingLinkedArtifactCount) &&
    value.missingLinkedArtifactCount >= 0
  );
}

export function isThreadDetailResponse(
  value: unknown,
): value is ThreadDetailResponse {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId) &&
    typeof value.snapshotVersion === 'string' &&
    value.snapshotVersion.trim() !== '' &&
    Array.isArray(value.messages) &&
    value.messages.every(isThreadMessage) &&
    (value.diagnostics === undefined ||
      isThreadDetailDiagnostics(value.diagnostics)) &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) &&
        value.artifacts.every(isThreadArtifactVersion)))
  );
}

export function isThreadDeleteResponse(
  value: unknown,
): value is ThreadDeleteResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId)
  );
}
