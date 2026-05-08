import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

import {
  appendApprovalRequestEntry,
  appendAssistantTranscriptText,
  appendSubagentTranscriptEntry,
} from './run-session-entry-state.js';
import type { ActiveRunViewState } from './run-session-state-types.js';

export function activateRunningRun(
  activeRunView: ActiveRunViewState,
  threadId: string,
  runId: string,
): ActiveRunViewState {
  return {
    ...clearPendingApprovalState(activeRunView),
    threadId,
    runId,
  };
}

export function activateCommittedArtifact(
  activeRunView: ActiveRunViewState,
  threadId: string,
  artifact: ThreadArtifactVersion,
): ActiveRunViewState {
  const artifactRef = {
    artifactId: artifact.artifactId,
    version: artifact.version,
  };

  return {
    ...activeRunView,
    threadId,
    artifactsByRef: {
      ...activeRunView.artifactsByRef,
      [createArtifactRefKey(artifactRef)]: artifact,
    },
    activeArtifactRef: artifactRef,
  };
}

export function clearPendingApprovalState(
  activeRunView: ActiveRunViewState,
): ActiveRunViewState {
  return {
    ...activeRunView,
    pendingApproval: null,
    pendingApprovals: [],
    streamError: null,
  };
}

export function setRunErrorState(
  activeRunView: ActiveRunViewState,
  threadId: string | null,
  message: string,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    runId: null,
    pendingApproval: null,
    pendingApprovals: [],
    streamError: message,
  };
}

export function setRunSyncFailedState(
  activeRunView: ActiveRunViewState,
  threadId: string,
  message: string,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    pendingApproval: null,
    pendingApprovals: [],
    streamError: message,
  };
}

export function appendAssistantAnswerText(
  activeRunView: ActiveRunViewState,
  threadId: string,
  text: string,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    finalAnswerText: activeRunView.finalAnswerText + text,
  };
}

export function appendAssistantTranscriptTextToActiveRun(
  activeRunView: ActiveRunViewState,
  threadId: string,
  text: string,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    transcriptEntries: appendAssistantTranscriptText(
      activeRunView.transcriptEntries,
      text,
    ),
  };
}

export function appendTranscriptActivity(
  activeRunView: ActiveRunViewState,
  threadId: string,
  entry: Exclude<RunTranscriptEntry, { kind: 'assistant_text' }>,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    transcriptEntries: [...activeRunView.transcriptEntries, entry],
  };
}

export function setPendingApproval(
  activeRunView: ActiveRunViewState,
  threadId: string,
  pendingApproval: ApprovalRequired,
): ActiveRunViewState {
  const pendingApprovals = enqueuePendingApproval(
    activeRunView.pendingApprovals,
    pendingApproval,
  );
  return {
    ...activeRunView,
    threadId,
    transcriptEntries: appendApprovalRequestEntry(
      activeRunView.transcriptEntries,
      pendingApproval,
    ),
    pendingApproval: activeRunView.pendingApproval ?? pendingApproval,
    pendingApprovals,
  };
}

export function clearResolvedPendingApproval(
  activeRunView: ActiveRunViewState,
  callId: string | undefined,
): ActiveRunViewState {
  if (callId === undefined) {
    return clearPendingApprovalState(activeRunView);
  }

  const hadQueuedApproval = activeRunView.pendingApprovals.some(
    (pendingApproval) => pendingApproval.callId === callId,
  );
  const pendingApprovals = activeRunView.pendingApprovals.filter(
    (pendingApproval) => pendingApproval.callId !== callId,
  );
  if (!hadQueuedApproval && activeRunView.pendingApproval?.callId !== callId) {
    return activeRunView;
  }

  return {
    ...activeRunView,
    pendingApproval: pendingApprovals[0] ?? null,
    pendingApprovals,
    streamError: null,
  };
}

export function appendSubagentActivityToActiveRun(
  activeRunView: ActiveRunViewState,
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): ActiveRunViewState {
  const nextTranscriptEntries = appendSubagentTranscriptEntry(
    activeRunView.transcriptEntries,
    entry,
  );
  if (nextTranscriptEntries === activeRunView.transcriptEntries) {
    return activeRunView;
  }
  return {
    ...activeRunView,
    transcriptEntries: nextTranscriptEntries,
  };
}

function enqueuePendingApproval(
  pendingApprovals: readonly ApprovalRequired[],
  pendingApproval: ApprovalRequired,
): ApprovalRequired[] {
  if (
    pendingApprovals.some((entry) => entry.callId === pendingApproval.callId)
  ) {
    return [...pendingApprovals];
  }
  return [...pendingApprovals, pendingApproval];
}
