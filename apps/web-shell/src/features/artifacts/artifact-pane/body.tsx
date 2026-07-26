import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

import { artifactPaneStyles, getArtifactBodyStyle } from './styles.js';
import type { ArtifactPreviewSurface as ResolvedArtifactPreviewSurface } from '../artifact-types.js';
import type { ArtifactTab } from './types.js';

export interface ArtifactPaneBodyProps {
  artifact: ThreadArtifactVersion;
  tab: ArtifactTab;
  previewSurface: ResolvedArtifactPreviewSurface | null;
  runtimeUnavailableMessage: string | null;
}

export function ArtifactPaneBody({
  artifact,
  tab,
  previewSurface,
  runtimeUnavailableMessage,
}: ArtifactPaneBodyProps) {
  return (
    <>
      {tab === 'show' && previewSurface ? (
        <div
          className="artifact-preview-surface"
          style={artifactPaneStyles.previewContainer}
        >
          <ArtifactPreviewSurface
            surface={previewSurface}
            runtimeUnavailableMessage={runtimeUnavailableMessage}
          />
        </div>
      ) : (
        <pre style={getArtifactBodyStyle('source')}>{artifact.payload}</pre>
      )}
    </>
  );
}

// 에디터 아티팩트 표면(artifact-editor-surface)도 같은 preview 분기를 쓴다
export function ArtifactPreviewSurface(props: {
  surface: ResolvedArtifactPreviewSurface;
  runtimeUnavailableMessage: string | null;
}) {
  const { surface, runtimeUnavailableMessage } = props;
  if (surface.kind === 'pending') {
    return (
      <div style={artifactPaneStyles.previewPendingBody}>
        <strong>캔버스 미리보기 준비 중</strong>
        <span>{surface.detail}</span>
      </div>
    );
  }
  if (surface.kind === 'unavailable') {
    return (
      <div style={artifactPaneStyles.runtimeUnavailableBody}>
        {runtimeUnavailableMessage ?? '이 캔버스를 열 수 없습니다.'}{' '}
        <strong>원문</strong> 탭에서 내용을 확인할 수 있습니다.
        {surface.detail.trim().length > 0 ? (
          <small style={artifactPaneStyles.runtimeUnavailableDetail}>
            {surface.detail}
          </small>
        ) : null}
      </div>
    );
  }
  return <>{surface.node}</>;
}
