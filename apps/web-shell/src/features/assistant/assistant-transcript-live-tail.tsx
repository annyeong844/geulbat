import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { ArtifactReferenceChip } from './artifact-pane/artifact-reference-chip.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import {
  canRenderInlineImageArtifact,
  InlineImageArtifactMessage,
} from './artifact-pane/inline-image-artifact.js';
import { assistantStyles } from './assistant-styles.js';
import { TranscriptTextMessage } from './assistant-transcript-message.js';
import { resolvePlanRenderingStampProjection } from '../artifacts/artifact-view-model.js';

export function AssistantTranscriptLiveTail(props: {
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
  streamError: string | null;
  streamErrorCode?: ErrorCode | null;
  hasUnreadStreamContent: boolean;
  isRunning: boolean;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  onJumpToLatest: () => void;
  // 존재하면 스트리밍 아티팩트도 인라인 대신 참조 칩 + 중앙 패널로 흐른다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}) {
  const {
    finalAnswerText,
    activeArtifact,
    planningWorkflowSnapshot = null,
    streamError,
    streamErrorCode = null,
    hasUnreadStreamContent,
    isRunning,
    onStartArtifactRun,
    onJumpToLatest,
    onOpenArtifact,
  } = props;
  const livePlanRendering =
    planningWorkflowSnapshot !== null &&
    planningWorkflowSnapshot.state !== 'collecting'
      ? resolvePlanRenderingStampProjection(
          planningWorkflowSnapshot,
          planningWorkflowSnapshot,
        )
      : null;

  return (
    <>
      {finalAnswerText ? (
        <TranscriptTextMessage
          messageRole="assistant"
          content={finalAnswerText}
          planRendering={livePlanRendering}
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
              planningWorkflowSnapshot={planningWorkflowSnapshot}
              isStreaming={isRunning}
              onOpen={onOpenArtifact}
            />
          </div>
        ) : (
          <CommittedArtifactMessage
            label="assistant"
            artifact={activeArtifact}
            isRunning={isRunning}
            planningWorkflowSnapshot={planningWorkflowSnapshot}
            {...(onStartArtifactRun !== undefined
              ? { onStartArtifactRun }
              : {})}
          />
        )
      ) : null}

      {streamErrorCode === 'llm_provider_request_outcome_unknown' ? (
        <div className="provider-outcome-unknown" role="alert">
          <strong>이전 요청의 결과를 아직 확인할 수 없어요</strong>
          <span>
            제공자가 이미 작업했을 가능성이 있어 자동으로 다시 보내지 않았어요.
            아래 복구 버튼을 누르면 살아 있는 요청과 늦게 도착한 결과를 먼저
            확인하고, 둘 다 없을 때만 이전 요청을 포기합니다. 이 경우 작업이나
            요금이 중복될 수 있어요.
          </span>
        </div>
      ) : streamError ? (
        <div style={assistantStyles.errorBanner} role="alert">
          응답 생성 실패. {streamError}
        </div>
      ) : null}

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
