import { createElement } from 'react';

import type { ArtifactRuntimeFrameRenderArgs } from '../../artifacts/runtime-preview/types.js';
import { ArtifactRuntimeFrame } from './artifact-runtime-frame.js';

export function renderArtifactRuntimeFrame(
  args: ArtifactRuntimeFrameRenderArgs,
) {
  return createElement(ArtifactRuntimeFrame, args);
}
