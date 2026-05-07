import {
  isArtifactRenderer,
  type ArtifactRenderer,
} from '@geulbat/protocol/artifacts';

import { buildMarkdownBlocks } from '../../lib/markdown/buildMarkdownBlocks.js';
import {
  renderedArtifactPreview,
  type ArtifactPreviewSurface,
} from './artifact-types.js';
import {
  renderCodeArtifactPreview,
  renderDiffArtifactPreview,
  renderTableArtifactPreview,
} from './artifact-renderer-previews.js';

type StaticArtifactPreviewRenderer = Extract<
  ArtifactRenderer,
  'markdown' | 'code' | 'diff' | 'table'
>;

interface StaticArtifactPreviewDefinition {
  render: (payload: string) => ArtifactPreviewSurface;
}

const staticArtifactPreviewRegistry = {
  markdown: {
    render(payload) {
      return renderedArtifactPreview(buildMarkdownBlocks(payload));
    },
  },
  code: {
    render(payload) {
      return renderedArtifactPreview(renderCodeArtifactPreview(payload));
    },
  },
  diff: {
    render(payload) {
      return renderedArtifactPreview(renderDiffArtifactPreview(payload));
    },
  },
  table: {
    render(payload) {
      return renderedArtifactPreview(renderTableArtifactPreview(payload));
    },
  },
} satisfies Record<
  StaticArtifactPreviewRenderer,
  StaticArtifactPreviewDefinition
>;

export function isStaticArtifactPreviewRenderer(
  renderer: ArtifactRenderer | string | null,
): renderer is StaticArtifactPreviewRenderer {
  return (
    isArtifactRenderer(renderer) &&
    (renderer === 'markdown' ||
      renderer === 'code' ||
      renderer === 'diff' ||
      renderer === 'table')
  );
}

export function resolveStaticArtifactPreview(
  renderer: StaticArtifactPreviewRenderer,
  payload: string,
): ArtifactPreviewSurface {
  return staticArtifactPreviewRegistry[renderer].render(payload);
}
