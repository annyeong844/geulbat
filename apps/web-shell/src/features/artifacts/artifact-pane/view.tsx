import { useState, type CSSProperties } from 'react';

import { getErrorMessage } from '../../../lib/error-message.js';

import { saveTextToLocalFile } from '../../../lib/save-local-file.js';

import type { ArtifactPaneControllerProps } from './controller-model.js';
import { ArtifactPaneBody } from './body.js';
import { ArtifactPaneExportPanel } from './export-panel.js';
import { ArtifactPaneHeader } from './header.js';
import { artifactPaneStyles } from './styles.js';

type ArtifactPaneViewProps = ArtifactPaneControllerProps;

// 확대: 같은 트리 위치에서 style만 바꿔 iframe 등 내부 상태를 보존한다.
const expandedContainerStyle: CSSProperties = {
  position: 'fixed',
  top: '5%',
  bottom: '5%',
  left: '8%',
  right: '8%',
  zIndex: 90,
  // container와 같은 longhand만 쓴다 — shorthand(margin/overflow) 혼용은
  // 접기/펼치기 rerender에서 스타일 제거 순서 버그를 만든다(React 경고)
  marginBottom: 0,
  overflow: 'auto',
  boxShadow: 'var(--elev-floating)',
  display: 'flex',
  flexDirection: 'column',
};

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 85,
  background: 'rgba(50, 34, 20, 0.35)',
  backdropFilter: 'blur(4px)',
  border: 'none',
  cursor: 'pointer',
};

export function ArtifactPaneView({
  headerProps,
  exportPanelProps,
  bodyProps,
  directSave,
}: ArtifactPaneViewProps) {
  const [expanded, setExpanded] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 인터프리터 산출물을 로컬 파일로 — OS 저장 대화상자에서 폴더를 고른다
  const handleSaveToFile = async () => {
    if (!directSave || savePending) {
      return;
    }
    setSavePending(true);
    setSaveError(null);
    try {
      await saveTextToLocalFile({
        suggestedName: directSave.defaultPath,
        payload: directSave.payload,
      });
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error));
    } finally {
      setSavePending(false);
    }
  };

  return (
    <>
      {expanded ? (
        <button
          type="button"
          aria-label="확대 닫기"
          style={backdropStyle}
          onClick={() => setExpanded(false)}
        />
      ) : null}
      <div
        className={expanded ? 'artifact-card-expanded' : undefined}
        style={
          expanded
            ? { ...artifactPaneStyles.container, ...expandedContainerStyle }
            : artifactPaneStyles.container
        }
      >
        <ArtifactPaneHeader
          {...headerProps}
          expanded={expanded}
          onToggleExpand={() => setExpanded((prev) => !prev)}
          {...(directSave
            ? {
                onSaveToFile: () => void handleSaveToFile(),
                savePending,
              }
            : {})}
        />

        {saveError ? (
          <div style={artifactPaneStyles.fallbackBanner} role="alert">
            저장 실패: {saveError}
          </div>
        ) : null}

        {exportPanelProps ? (
          <ArtifactPaneExportPanel {...exportPanelProps} />
        ) : null}

        <ArtifactPaneBody {...bodyProps} />
      </div>
    </>
  );
}
