import type { ArtifactPaneControllerProps } from './controller-model.js';
import { ArtifactPaneBody } from './body.js';
import { ArtifactPaneExportPanel } from './export-panel.js';
import { ArtifactPaneHeader } from './header.js';
import { artifactPaneStyles } from './styles.js';

type ArtifactPaneViewProps = ArtifactPaneControllerProps;

export function ArtifactPaneView({
  headerProps,
  exportPanelProps,
  bodyProps,
}: ArtifactPaneViewProps) {
  return (
    <div style={artifactPaneStyles.container}>
      <ArtifactPaneHeader {...headerProps} />

      {exportPanelProps ? (
        <ArtifactPaneExportPanel {...exportPanelProps} />
      ) : null}

      <ArtifactPaneBody {...bodyProps} />
    </div>
  );
}
