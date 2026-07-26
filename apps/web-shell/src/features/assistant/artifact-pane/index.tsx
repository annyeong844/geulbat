import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import { createElement } from 'react';

import { CommittedArtifactPane } from '../../artifacts/artifact-pane/committed-artifact-pane.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../../artifacts/runtime-preview/types.js';
import { ArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-frame-lazy.js';

export function CommittedArtifactMessage(props: {
  label: string;
  artifact: ThreadArtifactVersion;
  isRunning: boolean;
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
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
