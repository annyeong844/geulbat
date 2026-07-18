import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import { createElement } from 'react';

import { CommittedArtifactPane } from '../../artifacts/artifact-pane/committed-artifact-pane.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../../artifacts/runtime-preview/types.js';
import { ArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-frame.js';

export function CommittedArtifactMessage(props: {
  label: string;
  artifact: ThreadArtifactVersion;
  isRunning: boolean;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
}) {
  return (
    <CommittedArtifactPane
      {...props}
      renderRuntimeFrame={renderArtifactRuntimeFrame}
    />
  );
}

export function renderArtifactRuntimeFrame(
  args: ArtifactRuntimeFrameRenderArgs,
) {
  return createElement(ArtifactRuntimeFrame, args);
}
