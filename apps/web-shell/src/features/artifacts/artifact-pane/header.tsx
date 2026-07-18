import type { ReactNode } from 'react';

import {
  artifactPaneStyles,
  getStateBadgeStyle,
  getTabButtonStyle,
} from './styles.js';
import type { ArtifactSurfaceStateBadge, ArtifactTab } from './types.js';

export interface ArtifactPaneHeaderProps {
  label: string;
  surfaceStateBadge: ArtifactSurfaceStateBadge | null;
  tab: ArtifactTab;
  canShowPreview: boolean;
  showApply: boolean;
  canApply: boolean;
  showExport: boolean;
  exportExpanded: boolean;
  canOpenExport: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  savePending?: boolean;
  onSaveToFile?: () => Promise<void> | void;
  onSelectTab: (tab: ArtifactTab) => Promise<void> | void;
  onApply: () => Promise<void> | void;
  onToggleExport: () => Promise<void> | void;
}

export function ArtifactPaneHeader({
  label,
  surfaceStateBadge,
  tab,
  canShowPreview,
  showApply,
  canApply,
  showExport,
  exportExpanded,
  canOpenExport,
  expanded = false,
  onToggleExpand,
  savePending = false,
  onSaveToFile,
  onSelectTab,
  onApply,
  onToggleExport,
}: ArtifactPaneHeaderProps) {
  return (
    <div style={artifactPaneStyles.headerRow}>
      <div style={artifactPaneStyles.headerCopy}>
        <div style={artifactPaneStyles.label}>{label}</div>
        {surfaceStateBadge ? (
          <div style={artifactPaneStyles.metaRow}>
            <span style={getStateBadgeStyle(surfaceStateBadge.tone)}>
              {surfaceStateBadge.label}
            </span>
          </div>
        ) : null}
      </div>
      <div style={artifactPaneStyles.buttonRow}>
        <ArtifactTabButton
          active={tab === 'show'}
          disabled={!canShowPreview}
          onClick={() => onSelectTab('show')}
        >
          보기
        </ArtifactTabButton>
        <ArtifactTabButton
          active={tab === 'source'}
          onClick={() => onSelectTab('source')}
        >
          원문
        </ArtifactTabButton>
        {showApply ? (
          <ArtifactTabButton disabled={!canApply} onClick={onApply}>
            적용
          </ArtifactTabButton>
        ) : null}
        {showExport ? (
          <ArtifactTabButton
            active={exportExpanded}
            disabled={!canOpenExport}
            onClick={onToggleExport}
          >
            내보내기
          </ArtifactTabButton>
        ) : null}
        {onSaveToFile ? (
          <ArtifactTabButton disabled={savePending} onClick={onSaveToFile}>
            {savePending ? '저장 중…' : '저장'}
          </ArtifactTabButton>
        ) : null}
        {onToggleExpand ? (
          <ArtifactTabButton active={expanded} onClick={onToggleExpand}>
            {expanded ? '✕ 닫기' : '⛶ 확대'}
          </ArtifactTabButton>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactTabButton(props: {
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => Promise<void> | void;
}) {
  const { children, active = false, disabled = false, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick?.()}
      style={getTabButtonStyle(active, disabled)}
    >
      {children}
    </button>
  );
}
