import type {
  ArtifactRef,
  ThreadArtifactVersion,
  ThreadMessage,
  ThreadMessageMetadata,
} from './contract.js';

import type { AgentInput } from './loop-types.js';
import type { AgentArtifactCandidate, AgentResult } from './agent-result.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';

interface AssistantTranscriptEntry {
  role: 'assistant';
  content: string;
  timestamp: string;
  metadata: ThreadMessageMetadata;
}

type CommittedAssistantArtifact = Awaited<
  ReturnType<ResolvedExecuteForegroundRunDeps['commitThreadArtifactVersion']>
>;

export async function persistForegroundAssistantAnswer(args: {
  agentInput: AgentInput;
  result: AgentResult;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<boolean> {
  const { agentInput, result, deps } = args;
  const { runId, runContext, currentFile } = agentInput;
  const persistArgs: Parameters<typeof persistAssistantAnswer>[0] = {
    workspaceRoot: runContext.workspaceRoot,
    projectId: runContext.projectId,
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
  projectId: AgentInput['runContext']['projectId'];
  threadId: AgentInput['runContext']['threadId'];
  runId: string;
  currentFile?: string;
  finalProse: string;
  artifactCandidate?: AgentArtifactCandidate;
  onArtifactCommitted?: (artifact: ThreadArtifactVersion) => void;
  deps: ResolvedExecuteForegroundRunDeps;
}): Promise<void> {
  const {
    workspaceRoot,
    projectId,
    threadId,
    runId,
    currentFile,
    finalProse,
    artifactCandidate,
    onArtifactCommitted,
    deps,
  } = args;
  const timestamp = deps.now();
  const committedArtifact = artifactCandidate
    ? await deps.commitThreadArtifactVersion({
        workspaceRoot,
        projectId,
        threadId,
        runId,
        renderer: artifactCandidate.renderer,
        payload: artifactCandidate.payload,
        digest: artifactCandidate.digest,
        sourceRef:
          currentFile !== undefined
            ? {
                kind: 'thread-file',
                projectId,
                threadId,
                runId,
                filePath: currentFile,
                messageTimestamp: timestamp,
              }
            : {
                kind: 'thread',
                projectId,
                threadId,
                runId,
                filePath: null,
                messageTimestamp: timestamp,
              },
        timestamp,
      })
    : null;

  const assistantMetadataArgs: Parameters<
    typeof buildAssistantTranscriptMetadata
  >[0] = {
    runId,
    artifactRef: committedArtifact?.ref ?? null,
  };

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

function buildAssistantTranscriptMetadata(args: {
  runId: string;
  currentFile?: string;
  artifactRef?: ArtifactRef | null;
}): ThreadMessageMetadata {
  const metadata: ThreadMessageMetadata = {
    phase: 'final_answer',
    sourceRunId: args.runId,
  };
  if (args.currentFile) {
    metadata.sourceFile = args.currentFile;
  }
  if (args.artifactRef) {
    metadata.artifactRefs = [args.artifactRef];
    metadata.activeArtifactRef = args.artifactRef;
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
