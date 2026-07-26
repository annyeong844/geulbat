import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

import {
  appendApprovalRequestEntry,
  appendAssistantTranscriptText,
  appendSubagentTranscriptEntry,
} from './run-session-entry-state.js';
import type {
  ActiveRunViewState,
  PendingApprovalIdentity,
} from './run-session-state-types.js';

export function activateRunningRun(
  activeRunView: ActiveRunViewState,
  threadId: string,
  runId: string,
): ActiveRunViewState {
  return {
    ...clearPendingApprovalState(activeRunView),
    threadId,
    runId,
    // 이전 런의 미커밋 라이브 아티팩트 스트림은 새 런과 무관하다
    streamingArtifactText: '',
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
    // 이미지 아티팩트는 채팅 인라인 삽화다(inline-image-artifact.tsx) —
    // active로 승격하면 중앙 아티팩트 패널이 자동으로 열려 같은 그림이
    // 두 번 뜬다. 조회용 등록만 하고 승격은 건너뛴다.
    ...(artifact.renderer === 'image'
      ? {}
      : { activeArtifactRef: artifactRef }),
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
    streamErrorCode: null,
  };
}

export function setRunErrorState(
  activeRunView: ActiveRunViewState,
  threadId: string | null,
  code: ErrorCode | null,
  message: string,
): ActiveRunViewState {
  return {
    ...activeRunView,
    threadId,
    runId: null,
    pendingApproval: null,
    pendingApprovals: [],
    streamError: message,
    streamErrorCode: code,
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
    streamErrorCode: null,
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
  pendingApproval: PendingApprovalIdentity | undefined,
): ActiveRunViewState {
  if (pendingApproval === undefined) {
    return clearPendingApprovalState(activeRunView);
  }

  const hadQueuedApproval = activeRunView.pendingApprovals.some((entry) =>
    isSamePendingApprovalIdentity(entry, pendingApproval),
  );
  const pendingApprovals = activeRunView.pendingApprovals.filter(
    (entry) => !isSamePendingApprovalIdentity(entry, pendingApproval),
  );
  if (
    !hadQueuedApproval &&
    (activeRunView.pendingApproval === null ||
      !isSamePendingApprovalIdentity(
        activeRunView.pendingApproval,
        pendingApproval,
      ))
  ) {
    return activeRunView;
  }

  return {
    ...activeRunView,
    pendingApproval: pendingApprovals[0] ?? null,
    pendingApprovals,
    streamError: null,
    streamErrorCode: null,
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
    pendingApprovals.some((entry) =>
      isSamePendingApprovalIdentity(entry, pendingApproval),
    )
  ) {
    return [...pendingApprovals];
  }
  return [...pendingApprovals, pendingApproval];
}

function isSamePendingApprovalIdentity(
  left: PendingApprovalIdentity,
  right: PendingApprovalIdentity,
): boolean {
  return (
    left.callId === right.callId &&
    left.runId === right.runId &&
    left.threadId === right.threadId
  );
}
