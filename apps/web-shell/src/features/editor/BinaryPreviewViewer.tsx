import { useEffect, useState } from 'react';

import { baseNameOf } from '../../lib/path-name.js';

const IMAGE_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 이미지 줌 + 오디오/비디오 재생 + 파일 정보 — 미리보기 뷰어.
// The file API exposes media bytes but no caption-track reference. An empty
// <track> would claim captions exist, so this boundary remains an explicit
// exception until the file contract can supply a real caption source.
/* oxlint-disable jsx-a11y/media-has-caption */
export function BinaryPreviewViewer({
  preview,
}: {
  preview: {
    path: string;
    kind: 'image' | 'audio' | 'video' | 'unsupported';
    url?: string;
    byteSize?: number;
  };
}) {
  // 'fit' = 화면 맞춤, 숫자 = 실제 픽셀 대비 배율
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  useEffect(() => {
    setZoom('fit');
    setNaturalSize(null);
    setPlaybackFailed(false);
  }, [preview.path]);

  const stepZoom = (direction: 1 | -1) => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      const index = IMAGE_ZOOM_STEPS.findIndex((step) => step >= current);
      const base = index === -1 ? IMAGE_ZOOM_STEPS.length - 1 : index;
      const next = Math.min(
        IMAGE_ZOOM_STEPS.length - 1,
        Math.max(0, base + direction),
      );
      return IMAGE_ZOOM_STEPS[next] ?? 1;
    });
  };

  const infoParts: string[] = [];
  if (naturalSize) {
    infoParts.push(`${naturalSize.width}×${naturalSize.height}`);
  }
  if (preview.byteSize !== undefined) {
    infoParts.push(formatByteSize(preview.byteSize));
  }

  if (
    preview.kind === 'unsupported' ||
    preview.url === undefined ||
    playbackFailed
  ) {
    return (
      <div className="binary-preview">
        <div className="binary-preview-name">{baseNameOf(preview.path)}</div>
        <div className="manuscript-empty">
          <div className="manuscript-empty-icon">▣</div>
          <div className="manuscript-empty-title">
            {playbackFailed
              ? '이 파일은 브라우저가 재생하지 못해요'
              : '미리볼 수 없는 형식이에요'}
          </div>
          <div className="manuscript-empty-hint">
            텍스트, 이미지, 일반 미디어가 아닌 파일은 아직 열람을 지원하지
            않아요. 어시스턴트에게 내용 확인을 부탁할 수 있어요.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="binary-preview">
      <div className="binary-preview-header">
        <span className="binary-preview-name">
          {baseNameOf(preview.path)}
          {infoParts.length > 0 ? (
            <span className="binary-preview-info">
              {' '}
              · {infoParts.join(' · ')}
            </span>
          ) : null}
        </span>
        {preview.kind === 'image' || preview.kind === 'video' ? (
          <span
            className="binary-preview-zoom"
            role="toolbar"
            aria-label="확대"
          >
            <button
              type="button"
              className="format-btn"
              aria-label="축소"
              onClick={() => stepZoom(-1)}
            >
              −
            </button>
            <span className="binary-preview-zoom-value">
              {zoom === 'fit' ? '맞춤' : `${Math.round(zoom * 100)}%`}
            </span>
            <button
              type="button"
              className="format-btn"
              aria-label="확대"
              onClick={() => stepZoom(1)}
            >
              ＋
            </button>
            <button
              type="button"
              className="format-btn"
              aria-label="실제 크기"
              title="실제 크기 (100%)"
              onClick={() => setZoom(1)}
            >
              1:1
            </button>
            <button
              type="button"
              className="format-btn"
              aria-label="화면 맞춤"
              title="화면 맞춤"
              onClick={() => setZoom('fit')}
            >
              맞춤
            </button>
          </span>
        ) : null}
      </div>
      {preview.kind === 'image' ? (
        <div className="binary-preview-stage">
          <div
            className={`binary-preview-stage-inner${zoom === 'fit' ? ' fit' : ''}`}
          >
            <img
              className={`binary-preview-image${zoom === 'fit' ? ' fit' : ''}`}
              src={preview.url}
              alt={preview.path}
              style={
                zoom === 'fit' || !naturalSize
                  ? undefined
                  : { width: naturalSize.width * zoom }
              }
              onLoad={(event) => {
                const el = event.currentTarget;
                setNaturalSize({
                  width: el.naturalWidth,
                  height: el.naturalHeight,
                });
              }}
            />
          </div>
        </div>
      ) : preview.kind === 'video' ? (
        <div className="binary-preview-stage">
          <div
            className={`binary-preview-stage-inner${zoom === 'fit' ? ' fit' : ''}`}
          >
            <video
              className={`binary-preview-video${zoom === 'fit' ? ' fit' : ''}`}
              src={preview.url}
              controls
              style={
                zoom === 'fit' || !naturalSize
                  ? undefined
                  : { width: naturalSize.width * zoom }
              }
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                setNaturalSize({
                  width: el.videoWidth,
                  height: el.videoHeight,
                });
              }}
              onError={() => setPlaybackFailed(true)}
            />
          </div>
        </div>
      ) : (
        <audio
          className="binary-preview-audio"
          src={preview.url}
          controls
          onError={() => setPlaybackFailed(true)}
        />
      )}
    </div>
  );
}
/* oxlint-enable jsx-a11y/media-has-caption */
