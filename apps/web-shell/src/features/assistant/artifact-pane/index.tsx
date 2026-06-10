import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { CommittedArtifactPane } from '../../artifacts/artifact-pane/committed-artifact-pane.js';
import { renderArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-preview-adapter.js';

export function CommittedArtifactMessage(props: {
  label: string;
  artifact: ThreadArtifactVersion;
  isRunning: boolean;
  onOpenSource?: (path: string) => Promise<void> | void;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}) {
  return (
    <CommittedArtifactPane
      {...props}
      renderRuntimeFrame={renderArtifactRuntimeFrame}
    />
  );
}
