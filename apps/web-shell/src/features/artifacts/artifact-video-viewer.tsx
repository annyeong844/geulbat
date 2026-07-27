import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { VideoArtifactPayloadV1 } from '@geulbat/protocol/artifacts';

import { buildArtifactThreadMediaUrl } from './artifact-thread-media-url.js';

/**
 * 보기 크기 세 가지. 한 버튼이 이 순서로 돌아간다 — 각각을 따로 버튼으로 두면
 * 영상 위에 크롬이 세 개 얹힌다.
 */
const VIDEO_SIZING_CYCLE = ['fit', 'fill', 'original'] as const;

type VideoSizingMode = (typeof VIDEO_SIZING_CYCLE)[number];

const VIDEO_SIZING_LABEL: Record<VideoSizingMode, string> = {
  fit: '영역에 맞춰 보기',
  fill: '영역 가득 채우기',
  original: '원본 크기로 보기',
};

const VIDEO_SIZING_HINT: Record<VideoSizingMode, string> = {
  fit: '영상을 자르지 않고 이 영역 크기에 맞춥니다',
  fill: '비율을 지킨 채 영역을 가득 채웁니다 — 가장자리가 잘릴 수 있어요',
  original: '영상의 실제 픽셀 크기(1:1)를 유지합니다',
};

function nextVideoSizingMode(mode: VideoSizingMode): VideoSizingMode {
  const index = VIDEO_SIZING_CYCLE.indexOf(mode);
  return (
    VIDEO_SIZING_CYCLE[(index + 1) % VIDEO_SIZING_CYCLE.length] ??
    VIDEO_SIZING_CYCLE[0]
  );
}

/**
 * 동영상은 아티팩트가 차지한 자리에서 그대로 재생된다.
 *
 * 별도 창을 띄우면 같은 내용을 담은 네모가 둘이 되고, 보려면 한 번 더 눌러야
 * 한다. 아티팩트 자리가 이미 그 영상을 보여줄 자리다 — 이미지 아티팩트가
 * 그러듯이.
 *
 * 크기는 그 자리에서 오간다: 맞춤(자르지 않음) → 가득(네모칸을 채움) →
 * 원본(1:1). 원본은 영역보다 클 수 있으므로 무대가 스크롤을 갖는다 —
 * 잘라내지 않고 옮겨 볼 수 있어야 1:1이 의미가 있다.
 */
export function ArtifactVideoSurface(props: {
  manifest: VideoArtifactPayloadV1;
  threadId: string;
}) {
  const mediaUrl = buildArtifactThreadMediaUrl(
    props.threadId,
    props.manifest.source.mediaRef,
  );
  const [sizingMode, setSizingMode] = useState<VideoSizingMode>('fit');
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    setSizingMode('fit');
    setNaturalSize(null);
  }, [mediaUrl]);

  const nextMode = nextVideoSizingMode(sizingMode);
  // 실제 픽셀 크기를 알면 버튼이 그 값을 말한다. 원본 크기가 무엇인지 모르는
  // 채로 "원본 크기"를 누르게 두지 않는다.
  const naturalSizeLabel =
    nextMode !== 'original' || naturalSize === null
      ? ''
      : ` (${naturalSize.width}×${naturalSize.height})`;
  const originalSizeStyle: CSSProperties | undefined =
    sizingMode === 'original' && naturalSize !== null
      ? { width: naturalSize.width, height: naturalSize.height }
      : undefined;

  return (
    <div className="artifact-video-stage" data-video-sizing={sizingMode}>
      <div className="artifact-video-scroll">
        <div className={`artifact-video-canvas ${sizingMode}`}>
          {/* VideoArtifactPayloadV1에는 자막 트랙 참조가 없다. 빈 track을
              추가해 자막이 있는 것처럼 가장하지 않는다. */}
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            className={`artifact-video ${sizingMode}`}
            src={mediaUrl}
            controls
            preload="metadata"
            style={originalSizeStyle}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setNaturalSize({
                  width: video.videoWidth,
                  height: video.videoHeight,
                });
              }
            }}
          />
        </div>
      </div>
      {/*
        3단 순환이라 aria-pressed(2상태)로는 말할 수 없다. 이름이 지금 상태와
        누르면 될 상태를 함께 말한다.
      */}
      <button
        type="button"
        className="artifact-video-sizing"
        title={`${VIDEO_SIZING_LABEL[nextMode]} — ${VIDEO_SIZING_HINT[nextMode]}${naturalSizeLabel}`}
        aria-label={`${VIDEO_SIZING_LABEL[sizingMode]} 중 — 눌러서 ${VIDEO_SIZING_LABEL[nextMode]}`}
        onClick={() => setSizingMode(nextMode)}
      >
        <VideoSizingIcon mode={nextMode} />
      </button>
    </div>
  );
}

function VideoSizingIcon(props: { mode: VideoSizingMode }) {
  switch (props.mode) {
    case 'fit':
      return <FitToAreaIcon />;
    case 'fill':
      return <FillAreaIcon />;
    case 'original':
      return <ActualSizeIcon />;
  }
}

function ActualSizeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
    </svg>
  );
}

function FitToAreaIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m8 8 3 3M8 11V8h3M16 8l-3 3M13 8h3v3M8 16l3-3M8 13v3h3M16 16l-3-3M13 16h3v-3" />
    </svg>
  );
}

/** 안쪽에서 바깥 테두리로 밀어내는 화살표 — 네모칸을 가득 채운다. */
function FillAreaIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m11 11-3-3M8 11V8h3M13 11l3-3M16 11V8h-3M11 13l-3 3M8 13v3h3M13 13l3 3M16 13v3h-3" />
    </svg>
  );
}
