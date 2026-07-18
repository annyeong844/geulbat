import { stat } from 'node:fs/promises';

import {
  createSessionArtifactRefKey as createArtifactRefKey,
  readSessionActiveArtifactRefFromMetadata as readActiveArtifactRefFromMetadata,
  readSessionArtifactRefsFromMetadata as readArtifactRefsFromMetadata,
  type ThreadArtifactVersion,
  type ThreadDetailResponse,
  type ThreadId,
} from './contract.js';
import { createLogger } from '@geulbat/shared-utils/logger';

import { loadAllThreadArtifactVersions } from './artifact-store.js';
import { artifactStoreFilePath, threadFilePath } from './paths.js';
import { readTranscriptEntries } from './transcript-log.js';
import { loadThreadIndex } from './threads-index.js';
import { isNotFoundError } from '../utils/error.js';

const logger = createLogger('thread-detail');

interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export async function loadThreadDetailSnapshot(args: {
  workspaceRoot: string;
  threadId: ThreadId;
}): Promise<ThreadDetailResponse> {
  const messages = await readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const artifacts = await loadAllThreadArtifactVersions(
    args.workspaceRoot,
    args.threadId,
  );
  const snapshotVersion = await resolveThreadSnapshotVersion(args);
  const diagnostics = collectThreadDetailDiagnostics(messages, artifacts);
  emitThreadDetailDiagnostics(args.threadId, diagnostics);

  return {
    threadId: args.threadId,
    snapshotVersion,
    messages,
    artifacts,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

async function resolveThreadSnapshotVersion(args: {
  workspaceRoot: string;
  threadId: ThreadId;
}): Promise<string> {
  const entries = await loadThreadIndex(args.workspaceRoot);
  const summary = entries.find((entry) => entry.threadId === args.threadId);
  if (summary) {
    return summary.lastUpdated;
  }

  return resolveThreadSnapshotVersionFromFiles(
    args.workspaceRoot,
    args.threadId,
  );
}

async function resolveThreadSnapshotVersionFromFiles(
  workspaceRoot: string,
  threadId: ThreadId,
): Promise<string> {
  const snapshotCandidates = await Promise.all([
    readFileMtimeIso(threadFilePath(workspaceRoot, threadId)),
    readFileMtimeIso(artifactStoreFilePath(workspaceRoot, threadId)),
  ]);
  let latestTimestamp = '1970-01-01T00:00:00.000Z';
  for (const candidate of snapshotCandidates) {
    if (candidate && candidate.localeCompare(latestTimestamp) > 0) {
      latestTimestamp = candidate;
    }
  }
  return latestTimestamp;
}

async function readFileMtimeIso(filePath: string): Promise<string | null> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function collectThreadDetailDiagnostics(
  messages: Array<{
    metadata?: Parameters<typeof readArtifactRefsFromMetadata>[0];
  }>,
  artifacts: ThreadArtifactVersion[],
): ThreadDetailDiagnostics | null {
  const artifactKeys = new Set(
    artifacts.map((artifact) =>
      createArtifactRefKey({
        artifactId: artifact.artifactId,
        version: artifact.version,
      }),
    ),
  );
  const linkedArtifactKeys = new Set<string>();
  const missingLinkedArtifactKeys = new Set<string>();

  for (const message of messages) {
    const activeArtifactRef = readActiveArtifactRefFromMetadata(
      message.metadata,
    );
    if (activeArtifactRef) {
      const activeKey = createArtifactRefKey(activeArtifactRef);
      linkedArtifactKeys.add(activeKey);
      if (!artifactKeys.has(activeKey)) {
        missingLinkedArtifactKeys.add(activeKey);
      }
    }
    for (const ref of readArtifactRefsFromMetadata(message.metadata)) {
      const refKey = createArtifactRefKey(ref);
      linkedArtifactKeys.add(refKey);
      if (!artifactKeys.has(refKey)) {
        missingLinkedArtifactKeys.add(refKey);
      }
    }
  }

  const unlinkedPersistedArtifactCount = artifacts.reduce((count, artifact) => {
    const key = createArtifactRefKey({
      artifactId: artifact.artifactId,
      version: artifact.version,
    });
    return linkedArtifactKeys.has(key) ? count : count + 1;
  }, 0);

  const missingLinkedArtifactCount = missingLinkedArtifactKeys.size;

  if (
    unlinkedPersistedArtifactCount === 0 &&
    missingLinkedArtifactCount === 0
  ) {
    return null;
  }

  return {
    unlinkedPersistedArtifactCount,
    missingLinkedArtifactCount,
  };
}

function emitThreadDetailDiagnostics(
  threadId: ThreadId,
  diagnostics: ThreadDetailDiagnostics | null,
): void {
  if (!diagnostics) {
    return;
  }

  const { unlinkedPersistedArtifactCount, missingLinkedArtifactCount } =
    diagnostics;
  if (unlinkedPersistedArtifactCount > 0) {
    logger.warn(
      `thread ${threadId} has ${unlinkedPersistedArtifactCount} persisted artifact${unlinkedPersistedArtifactCount === 1 ? '' : 's'} without transcript linkage.`,
    );
  }
  if (missingLinkedArtifactCount > 0) {
    logger.warn(
      `thread ${threadId} has ${missingLinkedArtifactCount} transcript artifact linkage${missingLinkedArtifactCount === 1 ? '' : 's'} pointing to missing persisted artifacts.`,
    );
  }
}
