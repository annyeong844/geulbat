import { buildHtmlArtifactRuntimePayload } from './document.js';
import { validateHtmlArtifactPayload } from '../../html/validator.js';
import type {
  ArtifactPreviewSurface,
  ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import {
  renderedArtifactPreview,
  unavailableArtifactPreview,
} from '../../artifact-types.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';

export function resolveHtmlArtifactRuntimePreview(args: {
  payload: string;
  sourceRef: ResolvedArtifactSourceRef;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}): ArtifactPreviewSurface {
  const { payload, sourceRef, renderRuntimeFrame } = args;

  const validation = validateHtmlArtifactPayload(payload);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return renderedArtifactPreview(
    <HtmlArtifactPreviewFrame
      payload={payload}
      sourceRef={sourceRef}
      renderRuntimeFrame={renderRuntimeFrame}
    />,
  );
}

function HtmlArtifactPreviewFrame(props: {
  payload: string;
  sourceRef: ResolvedArtifactSourceRef;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}) {
  const { payload, sourceRef, renderRuntimeFrame } = props;
  return (
    <>
      {renderRuntimeFrame({
        renderer: 'html5',
        title: 'html5 artifact preview',
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        runtimePayload: buildHtmlArtifactRuntimePayload(payload),
        sourceRef,
      })}
    </>
  );
}
