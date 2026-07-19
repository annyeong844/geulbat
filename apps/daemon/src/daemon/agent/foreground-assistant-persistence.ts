import { createLogger } from '@geulbat/shared-utils/logger';

import type {
  ArtifactRef,
  RunId,
  ThreadArtifactVersion,
  ThreadMessage,
  ThreadMessageMetadata,
} from './contract.js';
import { assertAgentRunId } from './contract.js';

import type { AgentInput } from './loop-types.js';
import type { AgentArtifactCandidate, AgentResult } from './agent-result.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';

const logger = createLogger('agent/assistant-persistence');

interface AssistantTranscriptEntry {
  role: 'assistant';
  content: string;
  timestamp: string;
  metadata: ThreadMessageMetadata;
}

// commitKind는 롤백 경로를 가른다 — create 롤백은 아티팩트 전체 삭제,
// update 롤백은 방금 append한 버전만 걷어낸다(히스토리 보존).
type CommittedAssistantArtifact = Awaited<
  ReturnType<ResolvedExecuteForegroundRunDeps['commitThreadArtifactVersion']>
> & { commitKind: 'create' | 'update' };

export async function persistForegroundAssistantAnswer(args: {
  agentInput: AgentInput;
  result: AgentResult;
  deps: ResolvedExecuteForegroundRunDeps;
  toolCommittedArtifactRefs?: readonly ArtifactRef[];
}): Promise<boolean> {
  const { agentInput, result, deps } = args;
  const { runId, runContext, currentFile } = agentInput;
  const persistArgs: Parameters<typeof persistAssistantAnswer>[0] = {
    workspaceRoot: runContext.stateRoot,
    workingDirectory: runContext.workingDirectory,
    threadId: runContext.threadId,
    runId,
    finalProse: result.finalProse,
    onArtifactCommitted: (artifact) => {
      agentInput.onEvent({
        type: 'artifact_committed',
        payload: artifact,
      });
    },
    deps,
  };

  if (result.artifactCandidate !== undefined) {
    persistArgs.artifactCandidate = result.artifactCandidate;
  }

  if (
    args.toolCommittedArtifactRefs !== undefined &&
    args.toolCommittedArtifactRefs.length > 0
  ) {
    persistArgs.toolCommittedArtifactRefs = args.toolCommittedArtifactRefs;
  }

  if (currentFile !== undefined) {
    persistArgs.currentFile = currentFile;
  }

  try {
    await persistAssistantAnswer(persistArgs);
    return true;
  } catch (error: unknown) {
    deps.onPostRunPersistenceError('persist assistant transcript', error);
    return false;
  }
}

async function persistAssistantAnswer(args: {
  workspaceRoot: string;
  workingDirectory: string;
  threadId: AgentInput['runContext']['threadId'];
  runId: string;
  currentFile?: string;
  finalProse: string;
  artifactCandidate?: AgentArtifactCandidate;
  toolCommittedArtifactRefs?: readonly ArtifactRef[];
  onArtifactCommitted?: (artifact: ThreadArtifactVersion) => void;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const {
    workspaceRoot,
    workingDirectory,
    threadId,
    runId,
    currentFile,
    finalProse,
    artifactCandidate,
    onArtifactCommitted,
    deps,
  } = args;
  const sourceRunId = assertAgentRunId(runId);
  const timestamp = deps.now();
  const committedArtifact = artifactCandidate
    ? await commitAssistantArtifactCandidate({
        workspaceRoot,
        workingDirectory,
        threadId,
        runId: sourceRunId,
        ...(currentFile !== undefined ? { currentFile } : {}),
        candidate: artifactCandidate,
        timestamp,
        deps,
      })
    : null;

  const assistantMetadataArgs: Parameters<
    typeof buildAssistantTranscriptMetadata
  >[0] = {
    runId: sourceRunId,
    artifactRef: committedArtifact?.ref ?? null,
  };

  if (
    args.toolCommittedArtifactRefs !== undefined &&
    args.toolCommittedArtifactRefs.length > 0
  ) {
    assistantMetadataArgs.toolCommittedArtifactRefs =
      args.toolCommittedArtifactRefs;
  }

  if (currentFile !== undefined) {
    assistantMetadataArgs.currentFile = currentFile;
  }

  const assistantEntry: AssistantTranscriptEntry = {
    role: 'assistant',
    content: finalProse,
    metadata: buildAssistantTranscriptMetadata(assistantMetadataArgs),
    timestamp,
  };

  await appendAssistantTranscriptWithArtifactRollback({
    workspaceRoot,
    threadId,
    entry: assistantEntry,
    committedArtifact,
    onArtifactCommitted,
    deps,
  });
}

// 봉투에 updateTarget이 선언돼 있으면 같은 artifactId의 다음 버전으로
// append를 시도한다 (♻ 재작성이 "같은 아티팩트의 새 버전" 지시를 실제로
// 이행하는 경로). 대상이 무효하거나(미존재·렌더러 불일치·버전 충돌) 스테일
// 하면 새 아티팩트 생성으로 폴백해 모델 출력물을 잃지 않는다.
async function commitAssistantArtifactCandidate(args: {
  workspaceRoot: string;
  workingDirectory: string;
  threadId: AgentInput['runContext']['threadId'];
  runId: string;
  currentFile?: string;
  candidate: AgentArtifactCandidate;
  timestamp: string;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<CommittedAssistantArtifact> {
  const {
    workspaceRoot,
    workingDirectory,
    threadId,
    runId,
    currentFile,
    candidate,
    timestamp,
    deps,
  } = args;

  if (candidate.updateTarget !== undefined) {
    const updated = await deps.commitThreadArtifactUpdateVersion({
      workspaceRoot,
      threadId,
      artifactId: candidate.updateTarget.artifactId,
      baseVersion: candidate.updateTarget.baseVersion,
      payload: candidate.payload,
      createdByRunId: runId,
      timestamp,
      expectedRenderer: candidate.renderer,
    });
    if (updated.ok) {
      return {
        commitKind: 'update',
        artifact: updated.artifact,
        version: updated.version,
        ref: updated.ref,
      };
    }
    logger
      .withContext({ threadId, runId })
      .warn('artifact update target rejected; committing a new artifact:', {
        artifactId: candidate.updateTarget.artifactId,
        baseVersion: candidate.updateTarget.baseVersion,
        reason: updated.reason,
      });
  }

  const created = await deps.commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId,
    renderer: candidate.renderer,
    payload: candidate.payload,
    digest: candidate.digest,
    sourceRef:
      currentFile !== undefined
        ? {
            kind: 'thread-file',
            workingDirectory,
            threadId,
            runId,
            filePath: currentFile,
            messageTimestamp: timestamp,
          }
        : {
            kind: 'thread',
            workingDirectory,
            threadId,
            runId,
            filePath: null,
            messageTimestamp: timestamp,
          },
    timestamp,
  });
  return { commitKind: 'create', ...created };
}

function buildAssistantTranscriptMetadata(args: {
  runId: RunId;
  currentFile?: string;
  artifactRef?: ArtifactRef | null;
  toolCommittedArtifactRefs?: readonly ArtifactRef[];
}): ThreadMessageMetadata {
  const metadata: ThreadMessageMetadata = {
    phase: 'final_answer',
    sourceRunId: args.runId,
  };
  if (args.currentFile) {
    metadata.sourceFile = args.currentFile;
  }
  // 도구가 런 도중 커밋한 아티팩트(예: generate_image)도 이 메시지에 바인딩해
  // 재로드 시 트랜스크립트→아티팩트 복원이 가능하게 한다. 어시스턴트 본문
  // 아티팩트가 있으면 그쪽이 active로 우선한다.
  const refs: ArtifactRef[] = [...(args.toolCommittedArtifactRefs ?? [])];
  if (args.artifactRef) {
    refs.push(args.artifactRef);
  }
  const activeRef = args.artifactRef ?? refs.at(-1) ?? null;
  if (refs.length > 0 && activeRef) {
    metadata.artifactRefs = refs;
    metadata.activeArtifactRef = activeRef;
  }
  return metadata;
}

async function appendAssistantTranscriptWithArtifactRollback(args: {
  workspaceRoot: string;
  threadId: AgentInput['runContext']['threadId'];
  entry: AssistantTranscriptEntry;
  committedArtifact: CommittedAssistantArtifact | null;
  onArtifactCommitted: ((artifact: ThreadArtifactVersion) => void) | undefined;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const {
    workspaceRoot,
    threadId,
    entry,
    committedArtifact,
    onArtifactCommitted,
    deps,
  } = args;

  try {
    await deps.appendTranscriptEntry(workspaceRoot, threadId, entry);
    notifyCommittedAssistantArtifact(committedArtifact, onArtifactCommitted);
  } catch (error: unknown) {
    try {
      await recoverAssistantTranscriptEntry({
        workspaceRoot,
        threadId,
        entry,
        deps,
      });
      notifyCommittedAssistantArtifact(committedArtifact, onArtifactCommitted);
      return;
    } catch (recoveryError: unknown) {
      deps.onPostRunPersistenceError(
        'recover assistant transcript',
        recoveryError,
      );
    }
    await rollbackCommittedAssistantArtifact({
      workspaceRoot,
      threadId,
      committedArtifact,
      deps,
    });
    throw error;
  }
}

function notifyCommittedAssistantArtifact(
  committedArtifact: CommittedAssistantArtifact | null,
  onArtifactCommitted: ((artifact: ThreadArtifactVersion) => void) | undefined,
): void {
  if (!committedArtifact) {
    return;
  }

  onArtifactCommitted?.({
    ...committedArtifact.version,
    title: committedArtifact.artifact.title ?? null,
    persistenceEpoch: committedArtifact.artifact.persistenceEpoch,
    sourceRef: committedArtifact.artifact.sourceRef ?? null,
  });
}

async function rollbackCommittedAssistantArtifact(args: {
  workspaceRoot: string;
  threadId: AgentInput['runContext']['threadId'];
  committedArtifact: CommittedAssistantArtifact | null;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  if (!args.committedArtifact) {
    return;
  }

  try {
    if (args.committedArtifact.commitKind === 'update') {
      // update 롤백 — 히스토리를 보존하고 방금 append한 버전만 걷어낸다
      await args.deps.deleteThreadArtifactUpdateVersion({
        workspaceRoot: args.workspaceRoot,
        threadId: args.threadId,
        artifactId: args.committedArtifact.artifact.artifactId,
        version: args.committedArtifact.version.version,
      });
      return;
    }
    await args.deps.deleteThreadArtifact(
      args.workspaceRoot,
      args.threadId,
      args.committedArtifact.artifact.artifactId,
    );
  } catch (rollbackError: unknown) {
    args.deps.onPostRunPersistenceError(
      'rollback assistant artifact commit',
      rollbackError,
    );
  }
}

async function recoverAssistantTranscriptEntry(args: {
  workspaceRoot: string;
  threadId: AgentInput['runContext']['threadId'];
  entry: AssistantTranscriptEntry;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const transcript = await args.deps.readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  if (
    transcript.some((candidate) => isSameTranscriptEntry(candidate, args.entry))
  ) {
    return;
  }
  await args.deps.replaceTranscriptEntries(args.workspaceRoot, args.threadId, [
    ...transcript,
    args.entry,
  ]);
}

function isSameTranscriptEntry(
  left: ThreadMessage,
  right: AssistantTranscriptEntry,
): boolean {
  return (
    left.role === right.role &&
    left.content === right.content &&
    left.timestamp === right.timestamp &&
    JSON.stringify(left.metadata ?? null) ===
      JSON.stringify(right.metadata ?? null)
  );
}
