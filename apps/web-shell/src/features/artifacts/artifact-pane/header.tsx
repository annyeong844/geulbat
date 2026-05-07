import { type ReactNode } from 'react';

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
  showOpenSource: boolean;
  onSelectTab: (tab: ArtifactTab) => Promise<void> | void;
  onApply: () => Promise<void> | void;
  onToggleExport: () => Promise<void> | void;
  onOpenSource?: () => Promise<void> | void;
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
  showOpenSource,
  onSelectTab,
  onApply,
  onToggleExport,
  onOpenSource,
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
          active={tab === 'write'}
          onClick={() => onSelectTab('write')}
        >
          Write
        </ArtifactTabButton>
        <ArtifactTabButton
          active={tab === 'show'}
          disabled={!canShowPreview}
          onClick={() => onSelectTab('show')}
        >
          Show
        </ArtifactTabButton>
        <ArtifactTabButton
          active={tab === 'raw'}
          onClick={() => onSelectTab('raw')}
        >
          Raw
        </ArtifactTabButton>
        {showApply ? (
          <ArtifactTabButton disabled={!canApply} onClick={onApply}>
            Apply
          </ArtifactTabButton>
        ) : null}
        {showExport ? (
          <ArtifactTabButton
            active={exportExpanded}
            disabled={!canOpenExport}
            onClick={onToggleExport}
          >
            Export
          </ArtifactTabButton>
        ) : null}
        {showOpenSource ? (
          <ArtifactTabButton
            {...(onOpenSource !== undefined ? { onClick: onOpenSource } : {})}
          >
            원본 열기
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
