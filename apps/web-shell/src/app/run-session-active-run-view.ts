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
  return {
    ...activeRunView,
    threadId,
    transcriptEntries: appendApprovalRequestEntry(
      activeRunView.transcriptEntries,
      pendingApproval,
    ),
    pendingApproval,
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
