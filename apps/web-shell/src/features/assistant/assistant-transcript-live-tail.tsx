import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { ArtifactReferenceChip } from './artifact-pane/artifact-reference-chip.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import {
  canRenderInlineImageArtifact,
  InlineImageArtifactMessage,
} from './artifact-pane/inline-image-artifact.js';
import { assistantStyles } from './assistant-styles.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';
import { TranscriptTextMessage } from './assistant-transcript-message.js';

export function AssistantTranscriptLiveTail(props: {
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
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  onJumpToLatest: () => void;
  onOpenChildSession?: Parameters<
    typeof RunTranscriptEntryBlock
  >[0]['onOpenChildSession'];
  // 존재하면 스트리밍 아티팩트도 인라인 대신 참조 칩 + 중앙 패널로 흐른다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}) {
  const {
    finalAnswerText,
    activeArtifact,
    streamError,
    backgroundNotifications,
    backgroundNotificationKeys,
    hasUnreadStreamContent,
    isRunning,
    onStartArtifactRun,
    onJumpToLatest,
    onOpenChildSession,
    onOpenArtifact,
  } = props;

  return (
    <>
      {finalAnswerText ? (
        <TranscriptTextMessage
          messageRole="assistant"
          content={finalAnswerText}
        />
      ) : null}

      {activeArtifact ? (
        canRenderInlineImageArtifact(activeArtifact) ? (
          <div className="transcript-message from-assistant">
            <InlineImageArtifactMessage artifact={activeArtifact} />
          </div>
        ) : onOpenArtifact !== undefined ? (
          <div className="transcript-message from-assistant">
            <ArtifactReferenceChip
              artifact={activeArtifact}
              isStreaming={isRunning}
              onOpen={onOpenArtifact}
            />
          </div>
        ) : (
          <CommittedArtifactMessage
            label="assistant"
            artifact={activeArtifact}
            isRunning={isRunning}
            {...(onStartArtifactRun !== undefined
              ? { onStartArtifactRun }
              : {})}
          />
        )
      ) : null}

      {streamError ? (
        <div style={assistantStyles.errorBanner} role="alert">
          응답 생성 실패. {streamError}
        </div>
      ) : null}

      {backgroundNotifications.map((entry, index) => (
        <div
          key={
            backgroundNotificationKeys[index] ??
            `background-${entry.childRunId}`
          }
        >
          <RunTranscriptEntryBlock
            entry={entry}
            {...(onOpenChildSession !== undefined
              ? { onOpenChildSession }
              : {})}
          />
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
