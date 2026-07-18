import {
  isArtifactRenderer,
  parseImageArtifactPayload,
  parseVideoArtifactPayload,
  type ArtifactRenderer,
} from '@geulbat/protocol/artifacts';

import { buildMarkdownBlocks } from '../../lib/markdown/buildMarkdownBlocks.js';
import {
  renderedArtifactPreview,
  type ArtifactPreviewSurface,
  unavailableArtifactPreview,
} from './artifact-types.js';
import {
  renderCodeArtifactPreview,
  renderDiffArtifactPreview,
  renderImageArtifactPreview,
  renderTableArtifactPreview,
  renderVideoArtifactPreview,
} from './artifact-renderer-previews.js';

type StaticArtifactPreviewRenderer = Extract<
  ArtifactRenderer,
  'markdown' | 'code' | 'diff' | 'table' | 'image' | 'video'
>;

// 일부 렌더러(video)는 payload만으로 렌더할 수 없다 — 미디어 라우트 URL을
// 만들려면 스레드 스코프가 필요하다(§4.6). 호출자가 아는 만큼만 넘긴다.
export interface StaticArtifactPreviewContext {
  threadId?: string;
}

export const STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY = {
  policyId: 'artifact_static_preview_resource_v1',
  maxTextCodeUnits: 131_072,
  maxMarkdownLines: 2_000,
  maxDiffLines: 2_000,
  maxTableRows: 512,
  maxTableCells: 4_096,
  // 이미지 payload는 base64 매니페스트라 텍스트 한도와 별도로 관리한다.
  // 데몬 쪽 32MB 바이트 정책의 base64 팽창(4/3) + 여유분.
  maxImagePayloadCodeUnits: 64_000_000,
} as const;

interface StaticArtifactPreviewDefinition {
  render: (
    payload: string,
    context: StaticArtifactPreviewContext,
  ) => ArtifactPreviewSurface;
}

const staticArtifactPreviewRegistry = {
  markdown: {
    render(payload) {
      const resourceCheck = checkStaticPreviewMarkdownResource(payload);
      if (!resourceCheck.ok) {
        return blockedStaticArtifactPreview('markdown', resourceCheck.detail);
      }
      return renderedArtifactPreview(buildMarkdownBlocks(payload));
    },
  },
  code: {
    render(payload) {
      const resourceCheck = checkStaticPreviewTextResource(payload);
      if (!resourceCheck.ok) {
        return blockedStaticArtifactPreview('code', resourceCheck.detail);
      }
      return renderedArtifactPreview(renderCodeArtifactPreview(payload));
    },
  },
  diff: {
    render(payload) {
      const resourceCheck = checkStaticPreviewDiffResource(payload);
      if (!resourceCheck.ok) {
        return blockedStaticArtifactPreview('diff', resourceCheck.detail);
      }
      return renderedArtifactPreview(renderDiffArtifactPreview(payload));
    },
  },
  table: {
    render(payload) {
      const resourceCheck = checkStaticPreviewTableResource(payload);
      if (!resourceCheck.ok) {
        return blockedStaticArtifactPreview('table', resourceCheck.detail);
      }
      return renderedArtifactPreview(renderTableArtifactPreview(payload));
    },
  },
  image: {
    render(payload, context) {
      if (
        payload.length >
        STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxImagePayloadCodeUnits
      ) {
        return blockedStaticArtifactPreview(
          'image',
          `image payload has ${payload.length} code units; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxImagePayloadCodeUnits}`,
        );
      }
      const manifest = parseImageArtifactPayload(payload);
      if (manifest === null) {
        return unavailableArtifactPreview(
          'sanitize_rejected',
          'image artifact payload is not a valid generated-image manifest.',
        );
      }
      // thread_media 이미지(신형)는 미디어 라우트 URL 생성에 스레드 스코프가
      // 필요하다. inline_base64(구형)는 스코프 없이도 렌더된다.
      if (
        manifest.source.type === 'thread_media' &&
        context.threadId === undefined
      ) {
        return unavailableArtifactPreview(
          'sanitize_rejected',
          'image artifact preview requires a thread scope.',
        );
      }
      return renderedArtifactPreview(
        renderImageArtifactPreview(manifest, context.threadId),
      );
    },
  },
  video: {
    render(payload, context) {
      const manifest = parseVideoArtifactPayload(payload);
      if (manifest === null) {
        return unavailableArtifactPreview(
          'sanitize_rejected',
          'video artifact payload is not a valid generated-video manifest.',
        );
      }
      if (context.threadId === undefined) {
        // 미디어 라우트는 스레드 스코프다 — 스코프를 모르면 렌더하지 않는다
        // (잘못된 URL로 조용히 깨지는 것 방지, fail-closed)
        return unavailableArtifactPreview(
          'sanitize_rejected',
          'video artifact preview requires a thread scope.',
        );
      }
      return renderedArtifactPreview(
        renderVideoArtifactPreview(manifest, context.threadId),
      );
    },
  },
} satisfies Record<
  StaticArtifactPreviewRenderer,
  StaticArtifactPreviewDefinition
>;

export function isStaticArtifactPreviewRenderer(
  renderer: string | null,
): renderer is StaticArtifactPreviewRenderer {
  return (
    isArtifactRenderer(renderer) &&
    (renderer === 'markdown' ||
      renderer === 'code' ||
      renderer === 'diff' ||
      renderer === 'table' ||
      renderer === 'image' ||
      renderer === 'video')
  );
}

export function resolveStaticArtifactPreview(
  renderer: StaticArtifactPreviewRenderer,
  payload: string,
  context: StaticArtifactPreviewContext = {},
): ArtifactPreviewSurface {
  return staticArtifactPreviewRegistry[renderer].render(payload, context);
}

function checkStaticPreviewTextResource(
  payload: string,
): { ok: true } | { ok: false; detail: string } {
  if (
    payload.length > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTextCodeUnits
  ) {
    return {
      ok: false,
      detail: `payload has ${payload.length} code units; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTextCodeUnits}`,
    };
  }
  return { ok: true };
}

function checkStaticPreviewMarkdownResource(
  payload: string,
): { ok: true } | { ok: false; detail: string } {
  const textCheck = checkStaticPreviewTextResource(payload);
  if (!textCheck.ok) {
    return textCheck;
  }
  const lineCount = countLinesUpTo(
    payload,
    STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines + 1,
  );
  if (lineCount > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines) {
    return {
      ok: false,
      detail: `markdown has ${lineCount} lines; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines}`,
    };
  }
  return { ok: true };
}

function checkStaticPreviewDiffResource(
  payload: string,
): { ok: true } | { ok: false; detail: string } {
  const textCheck = checkStaticPreviewTextResource(payload);
  if (!textCheck.ok) {
    return textCheck;
  }
  const lineCount = countLinesUpTo(
    payload,
    STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxDiffLines + 1,
  );
  if (lineCount > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxDiffLines) {
    return {
      ok: false,
      detail: `diff has ${lineCount} lines; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxDiffLines}`,
    };
  }
  return { ok: true };
}

function checkStaticPreviewTableResource(
  payload: string,
): { ok: true } | { ok: false; detail: string } {
  const textCheck = checkStaticPreviewTextResource(payload);
  if (!textCheck.ok) {
    return textCheck;
  }
  const tableSize = inspectTableResource(payload);
  if (tableSize.rows > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableRows) {
    return {
      ok: false,
      detail: `table has ${tableSize.rows} rows; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableRows}`,
    };
  }
  if (tableSize.cells > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableCells) {
    return {
      ok: false,
      detail: `table has ${tableSize.cells} cells; static preview policy allows ${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableCells}`,
    };
  }
  return { ok: true };
}

function countLinesUpTo(payload: string, limit: number): number {
  if (payload.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = 0; index < payload.length; index += 1) {
    if (payload.charCodeAt(index) === 10) {
      count += 1;
      if (count >= limit) {
        return count;
      }
    }
  }
  return count;
}

function inspectTableResource(payload: string): {
  rows: number;
  cells: number;
} {
  let rows = 0;
  let cells = 0;
  let lineStart = 0;
  while (lineStart <= payload.length) {
    const nextLineBreak = payload.indexOf('\n', lineStart);
    const lineEnd = nextLineBreak === -1 ? payload.length : nextLineBreak;
    const line = payload.slice(lineStart, lineEnd).trim();
    if (line.length > 0 && !isMarkdownTableDivider(line)) {
      rows += 1;
      cells += countTableCells(line);
      if (
        rows > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableRows ||
        cells > STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableCells
      ) {
        return { rows, cells };
      }
    }
    if (nextLineBreak === -1) {
      break;
    }
    lineStart = nextLineBreak + 1;
  }
  return { rows, cells };
}

function countTableCells(line: string): number {
  if (line.includes('|')) {
    const rawCellCount = line.split('|').length;
    const leadingEdge = line.startsWith('|') ? 1 : 0;
    const trailingEdge = line.endsWith('|') ? 1 : 0;
    return Math.max(0, rawCellCount - leadingEdge - trailingEdge);
  }
  if (line.includes('\t')) {
    return line.split('\t').length;
  }
  return 1;
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line);
}

function blockedStaticArtifactPreview(
  renderer: StaticArtifactPreviewRenderer,
  detail: string,
): ArtifactPreviewSurface {
  return unavailableArtifactPreview(
    'policy_blocked',
    `${STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.policyId}: ${renderer} preview was not rendered because ${detail}. Raw/source content remains available.`,
  );
}
