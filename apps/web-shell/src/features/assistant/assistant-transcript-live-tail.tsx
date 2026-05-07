import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import { assistantStyles } from './assistant-styles.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';
import { TranscriptTextMessage } from './assistant-transcript-content.js';

export function AssistantTranscriptLiveTail(props: {
  showStartingPlaceholder: boolean;
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  streamError: string | null;
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  backgroundNotificationKeys: string[];
  hasUnreadStreamContent: boolean;
  isRunning: boolean;
  onOpenSource?: (path: string) => Promise<void> | void;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  onJumpToLatest: () => void;
}) {
  const {
    showStartingPlaceholder,
    finalAnswerText,
    activeArtifact,
    streamError,
    backgroundNotifications,
    backgroundNotificationKeys,
    hasUnreadStreamContent,
    isRunning,
    onOpenSource,
    onStartArtifactRun,
    onJumpToLatest,
  } = props;

  return (
    <>
      {showStartingPlaceholder ? (
        <div style={assistantStyles.startingBlock}>
          <div style={assistantStyles.messageRole}>assistant (starting...)</div>
          <pre style={assistantStyles.messageText}>Thinking...</pre>
        </div>
      ) : null}

      {finalAnswerText ? (
        <TranscriptTextMessage role="assistant" content={finalAnswerText} />
      ) : null}

      {activeArtifact ? (
        <CommittedArtifactMessage
          label="assistant"
          artifact={activeArtifact}
          isRunning={isRunning}
          {...(onOpenSource !== undefined ? { onOpenSource } : {})}
          {...(onStartArtifactRun !== undefined ? { onStartArtifactRun } : {})}
        />
      ) : null}

      {streamError ? (
        <div style={assistantStyles.errorBanner}>{streamError}</div>
      ) : null}

      {backgroundNotifications.map((entry, index) => (
        <div
          key={
            backgroundNotificationKeys[index] ??
            `background-${entry.childRunId}`
          }
          style={assistantStyles.backgroundNotification}
        >
          <RunTranscriptEntryBlock entry={entry} />
        </div>
      ))}

      {hasUnreadStreamContent ? (
        <div style={assistantStyles.unreadNoticeRow}>
          <button
            type="button"
            onClick={onJumpToLatest}
            style={assistantStyles.unreadNoticeButton}
          >
            새 메시지 보기
          </button>
        </div>
      ) : null}
    </>
  );
}
