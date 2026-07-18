import { useState } from 'react';
import {
  VIDEO_GENERATION_ASPECT_RATIOS,
  VIDEO_GENERATION_RESOLUTIONS,
  type VideoGenerationAspectRatio,
  type VideoGenerationResolution,
} from '@geulbat/protocol/run-contract';
import type { VIDEO_GENERATION_MODEL_CATALOG } from '@geulbat/protocol/run-contract';

import { MenuOptionRow } from './composer-menu-rows.js';
import {
  setVideoGenerationPref,
  type VideoGenerationPref,
} from './video-generation-prefs.js';

// 동영상 설정 다이얼로그 — 열릴 때 mount되며 draft 상태를 스스로 소유한다.
// 저장/해제는 video-generation-prefs 스토어에 직접 쓰고, 부모에는 토스트
// 문구(onNotice)와 닫힘(onClose)만 알린다.
export function VideoSettingsDialog({
  videoModel,
  videoModelVerified,
  videoModelConnected,
  videoPref,
  onClose,
  onNotice,
}: {
  videoModel: (typeof VIDEO_GENERATION_MODEL_CATALOG)[number];
  videoModelVerified: boolean;
  videoModelConnected: boolean;
  videoPref: VideoGenerationPref | null;
  onClose: () => void;
  onNotice: (notice: string) => void;
}) {
  const [videoDraftEnabled, setVideoDraftEnabled] = useState(
    videoPref !== null,
  );
  const [videoDraftDuration, setVideoDraftDuration] = useState(
    videoPref?.durationSeconds ?? 5,
  );
  // '자동' = 미지정(프로바이더 기본) — null로 표현한다
  const [videoDraftAspectRatio, setVideoDraftAspectRatio] =
    useState<VideoGenerationAspectRatio | null>(videoPref?.aspectRatio ?? null);
  const [videoDraftResolution, setVideoDraftResolution] =
    useState<VideoGenerationResolution | null>(videoPref?.resolution ?? null);
  return (
    <>
      <button
        type="button"
        aria-label="동영상 설정 닫기"
        className="video-settings-backdrop"
        onClick={onClose}
      />
      <div
        className="video-settings-card"
        role="dialog"
        aria-label="동영상 설정"
      >
        <div className="video-settings-header">
          <span className="video-settings-title">동영상 설정</span>
          <button
            type="button"
            className="video-settings-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="composer-menu-note">
          대화에서 &ldquo;…동영상 만들어줘&rdquo;라고 요청하면 이 설정으로
          생성돼요. 이미지를 먼저 그렸다면 &ldquo;움직여줘&rdquo;로 애니메이션할
          수 있어요.
        </div>
        <MenuOptionRow
          title={videoModel.label}
          description={
            !videoModelVerified
              ? '검증 대기'
              : !videoModelConnected
                ? 'AI 제공자 연결 필요'
                : 'xAI · 글·이미지 모두 이 모델로'
          }
          checked={videoDraftEnabled}
          disabled={!videoModelVerified || !videoModelConnected}
          onClick={() => setVideoDraftEnabled(true)}
        />
        <MenuOptionRow
          title="시스템 기본값"
          description="선택 해제 — 데몬 기본 설정을 따릅니다"
          checked={!videoDraftEnabled}
          onClick={() => setVideoDraftEnabled(false)}
        />
        <div
          className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
        >
          <span className="video-settings-detail-label">
            길이 <strong>{videoDraftDuration}초</strong>
          </span>
          <input
            type="range"
            min={1}
            max={15}
            step={1}
            value={videoDraftDuration}
            disabled={!videoDraftEnabled}
            aria-label="동영상 길이(초)"
            onChange={(event) =>
              setVideoDraftDuration(Number(event.target.value))
            }
          />
          <span className="video-settings-detail-hint">
            길수록 생성이 오래 걸려요 (1~15초)
          </span>
        </div>
        <div
          className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
        >
          <span className="video-settings-detail-label">
            화면비 <strong>{videoDraftAspectRatio ?? '자동'}</strong>
          </span>
          <div
            className="video-settings-chips"
            role="radiogroup"
            aria-label="화면비"
          >
            <button
              type="button"
              className={`video-settings-chip${videoDraftAspectRatio === null ? ' active' : ''}`}
              disabled={!videoDraftEnabled}
              onClick={() => setVideoDraftAspectRatio(null)}
            >
              자동
            </button>
            {VIDEO_GENERATION_ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                className={`video-settings-chip${videoDraftAspectRatio === ratio ? ' active' : ''}`}
                disabled={!videoDraftEnabled}
                onClick={() => setVideoDraftAspectRatio(ratio)}
              >
                {ratio}
              </button>
            ))}
          </div>
        </div>
        <div
          className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
        >
          <span className="video-settings-detail-label">
            해상도 <strong>{videoDraftResolution ?? '자동'}</strong>
          </span>
          <div
            className="video-settings-chips"
            role="radiogroup"
            aria-label="해상도"
          >
            <button
              type="button"
              className={`video-settings-chip${videoDraftResolution === null ? ' active' : ''}`}
              disabled={!videoDraftEnabled}
              onClick={() => setVideoDraftResolution(null)}
            >
              자동
            </button>
            {VIDEO_GENERATION_RESOLUTIONS.map((resolution) => (
              <button
                key={resolution}
                type="button"
                className={`video-settings-chip${videoDraftResolution === resolution ? ' active' : ''}`}
                disabled={!videoDraftEnabled}
                onClick={() => setVideoDraftResolution(resolution)}
              >
                {resolution}
              </button>
            ))}
          </div>
          <span className="video-settings-detail-hint">
            자동이면 모델이 알아서 정해요. 해상도가 높을수록 오래 걸려요.
          </span>
        </div>
        <div className="video-settings-actions">
          <button
            type="button"
            className="video-settings-save"
            onClick={() => {
              if (videoDraftEnabled) {
                setVideoGenerationPref({
                  model: videoModel.id,
                  durationSeconds: videoDraftDuration,
                  ...(videoDraftAspectRatio !== null
                    ? { aspectRatio: videoDraftAspectRatio }
                    : {}),
                  ...(videoDraftResolution !== null
                    ? { resolution: videoDraftResolution }
                    : {}),
                });
                onNotice(
                  `동영상 설정을 저장했어요 — ${videoModel.label} · ${videoDraftDuration}초${videoDraftAspectRatio !== null ? ` · ${videoDraftAspectRatio}` : ''}${videoDraftResolution !== null ? ` · ${videoDraftResolution}` : ''}`,
                );
              } else {
                setVideoGenerationPref(null);
                onNotice('동영상 설정을 해제했어요');
              }
              onClose();
            }}
          >
            저장
          </button>
        </div>
      </div>
    </>
  );
}
