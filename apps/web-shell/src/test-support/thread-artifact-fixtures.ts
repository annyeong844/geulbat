import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { brandThreadId } from '../lib/id-brand-helpers.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

type CommittedArtifactSourceRef = NonNullable<
  ThreadArtifactVersion['sourceRef']
>;

export function createCommittedArtifactSourceRef(
  overrides: Partial<Omit<CommittedArtifactSourceRef, 'kind' | 'filePath'>> & {
    filePath?: string | null;
  } = {},
): CommittedArtifactSourceRef {
  const workingDirectory = overrides.workingDirectory ?? 'workspace';
  const threadId = overrides.threadId ?? THREAD_ID;
  const runId = overrides.runId ?? 'run-1';
  const messageTimestamp =
    overrides.messageTimestamp ?? '2026-03-24T00:00:01.000Z';
  const filePath =
    overrides.filePath === undefined ? 'episodes/ch01.md' : overrides.filePath;

  if (filePath === null) {
    return {
      kind: 'thread',
      workingDirectory,
      threadId,
      runId,
      filePath: null,
      messageTimestamp,
    };
  }

  return {
    kind: 'thread-file',
    workingDirectory,
    threadId,
    runId,
    filePath,
    messageTimestamp,
  };
}

export function createCommittedArtifact(
  overrides: Partial<ThreadArtifactVersion> & {
    artifactId: string;
    renderer: ThreadArtifactVersion['renderer'];
    payload: string;
  },
): ThreadArtifactVersion {
  return {
    artifactId: overrides.artifactId,
    version: overrides.version ?? 1,
    parentVersion: overrides.parentVersion ?? null,
    baseVersion: overrides.baseVersion ?? null,
    renderer: overrides.renderer,
    payload: overrides.payload,
    digest: overrides.digest ?? null,
    contentHash: overrides.contentHash ?? 'hash',
    createdAt: overrides.createdAt ?? '2026-03-24T00:00:01.000Z',
    createdByRunId: overrides.createdByRunId ?? 'run-1',
    previewValidation: overrides.previewValidation ?? { ok: true },
    title: overrides.title ?? null,
    persistenceEpoch: overrides.persistenceEpoch ?? 0,
    sourceRef: overrides.sourceRef ?? createCommittedArtifactSourceRef(),
  };
}

export function createCommittedArtifactMessage(
  artifact: ThreadArtifactVersion,
  overrides: Partial<{
    content: string;
    timestamp: string;
    sourceFile: string;
    sourceRunId: string;
  }> = {},
): ThreadMessage {
  const sourceFile =
    overrides.sourceFile ?? artifact.sourceRef?.filePath ?? undefined;
  const sourceRunId =
    overrides.sourceRunId ?? artifact.sourceRef?.runId ?? undefined;
  return {
    entryId: `entry-${artifact.artifactId}-${artifact.version}`,
    role: 'assistant' as const,
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? '2026-03-24T00:00:01.000Z',
    metadata: {
      phase: 'final_answer',
      ...(sourceFile !== undefined ? { sourceFile } : {}),
      ...(sourceRunId !== undefined ? { sourceRunId } : {}),
      artifactRefs: [
        { artifactId: artifact.artifactId, version: artifact.version },
      ],
      activeArtifactRef: {
        artifactId: artifact.artifactId,
        version: artifact.version,
      },
    },
  };
}
