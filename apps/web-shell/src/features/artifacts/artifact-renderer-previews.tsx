import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  ImageArtifactPayloadV1,
  VideoArtifactPayloadV1,
} from '@geulbat/protocol/artifacts';

import { saveBlobToLocalFile } from '../../lib/save-local-file.js';
import { buildArtifactThreadMediaUrl } from './artifact-thread-media-url.js';
import { ArtifactVideoSurface } from './artifact-video-viewer.js';

// 저장 파일명 제안용 — mimeType에서 확장자를 뽑는다
const MEDIA_FILE_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function mediaFileExtensionOf(mimeType: string): string {
  return MEDIA_FILE_EXTENSIONS[mimeType] ?? mimeType.split('/')[1] ?? 'bin';
}

// 미디어 저장 버튼 — OS 저장 대화상자로 위치를 고른다(다운로드 폴더 강제
// 금지). 브라우저가 미지원이면 제안 파일명으로 기본 다운로드 폴백.
function MediaSaveButton(props: { mediaUrl: string; suggestedName: string }) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>(
    'idle',
  );
  const handleSave = async () => {
    setSaveState('saving');
    try {
      const response = await fetch(props.mediaUrl);
      if (!response.ok) {
        throw new Error(`media fetch failed: HTTP ${response.status}`);
      }
      const blob = await response.blob();
      await saveBlobToLocalFile({
        suggestedName: props.suggestedName,
        blob,
      });
      setSaveState('idle');
    } catch {
      setSaveState('failed');
    }
  };
  return (
    <button
      type="button"
      className="artifact-editor-action artifact-media-save"
      title="위치를 골라 저장"
      disabled={saveState === 'saving'}
      onClick={() => void handleSave()}
    >
      {saveState === 'saving'
        ? '저장 중…'
        : saveState === 'failed'
          ? '저장 실패 — 다시 시도'
          : '저장'}
    </button>
  );
}

// renderer preview — Modern Heritage 토큰만 참조 (색상 리터럴 금지)
const artifactRendererPreviewStyles = {
  codePreview: {
    margin: 0,
    padding: '14px 16px',
    background: 'var(--primary)',
    color: 'var(--on-primary)',
    borderRadius: 8,
    overflowX: 'auto',
    fontSize: 12,
    lineHeight: 1.55,
    fontFamily: 'var(--font-ui-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  diffPreview: {
    margin: 0,
    borderRadius: 8,
    overflow: 'hidden',
    background: 'var(--surface-container-lowest)',
    fontSize: 12,
    lineHeight: 1.55,
    fontFamily: 'var(--font-ui-mono)',
    boxShadow: 'var(--elev-card)',
  },
  diffLine: {
    padding: '4px 12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  diffAdded: {
    background: 'var(--secondary-soft)',
    color: 'var(--on-secondary-fixed-variant)',
  },
  diffRemoved: {
    background: 'rgba(177, 74, 58, 0.12)',
    color: 'var(--error)',
  },
  diffHunk: {
    background: 'var(--warning-bg)',
    color: 'var(--warning-text)',
  },
  diffMeta: {
    background: 'var(--surface-container-low)',
    color: 'var(--on-surface-muted)',
  },
  tableWrap: {
    overflowX: 'auto',
    borderRadius: 8,
    background: 'var(--surface-container-lowest)',
    boxShadow: 'var(--elev-card)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    lineHeight: 1.5,
  },
  tableHeadCell: {
    padding: '8px 10px',
    textAlign: 'left',
    background: 'var(--surface-container)',
    color: 'var(--on-surface-variant)',
    fontWeight: 600,
    fontFamily: 'var(--font-ui-label)',
  },
  tableCell: {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(50, 34, 20, 0.06)',
    color: 'var(--on-surface-variant)',
    verticalAlign: 'top',
  },
} satisfies Record<string, CSSProperties>;

export function renderCodeArtifactPreview(payload: string): ReactNode {
  return <pre style={artifactRendererPreviewStyles.codePreview}>{payload}</pre>;
}

export function renderImageArtifactPreview(
  manifest: ImageArtifactPayloadV1,
  threadId: string | undefined,
): ReactNode {
  const { provenance } = manifest;
  const caption = provenance.revisedPrompt ?? provenance.prompt;
  // 소스 두 형태(S4b 이관 전후): inline_base64(구)는 data URL 직접,
  // thread_media(신)는 인증 media 라우트에서 스트리밍(base64 스냅샷 소멸).
  const src =
    manifest.source.type === 'inline_base64'
      ? `data:${manifest.mimeType};base64,${manifest.source.dataBase64}`
      : threadId !== undefined
        ? buildArtifactThreadMediaUrl(threadId, manifest.source.mediaRef)
        : null;
  if (src === null) {
    // thread_media인데 스레드 스코프를 모르면 잘못된 URL 대신 캡션만
    return (
      <figure className="artifact-media-figure">
        <figcaption className="artifact-media-footer">
          <span className="artifact-media-meta">
            {caption} — {provenance.model}
          </span>
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="artifact-media-figure">
      <div className="artifact-media-stage">
        <img
          className="artifact-media-image"
          src={src}
          alt={provenance.prompt}
        />
      </div>
      <figcaption className="artifact-media-footer">
        <details className="artifact-media-prompt">
          <summary title="프롬프트 펼치기/접기">{caption}</summary>
        </details>
        <span className="artifact-media-meta">{provenance.model}</span>
        <MediaSaveButton
          mediaUrl={src}
          suggestedName={`이미지.${mediaFileExtensionOf(manifest.mimeType)}`}
        />
      </figcaption>
    </figure>
  );
}

// 동영상은 이미지와 같은 자리에 같은 방식으로 놓인다: 무대 + provenance
// footer. 재생과 크기 전환은 무대가 소유한다.
export function renderVideoArtifactPreview(
  manifest: VideoArtifactPayloadV1,
  threadId: string,
): ReactNode {
  const { provenance } = manifest;
  const mediaUrl = buildArtifactThreadMediaUrl(
    threadId,
    manifest.source.mediaRef,
  );
  const durationLabel =
    manifest.durationSeconds !== undefined
      ? ` · ${manifest.durationSeconds}초`
      : '';
  return (
    <figure className="artifact-media-figure">
      <ArtifactVideoSurface manifest={manifest} threadId={threadId} />
      <figcaption className="artifact-media-footer">
        <details className="artifact-media-prompt">
          <summary title="프롬프트 펼치기/접기">{provenance.prompt}</summary>
        </details>
        <span className="artifact-media-meta">
          {provenance.model}
          {durationLabel}
        </span>
        <MediaSaveButton
          mediaUrl={mediaUrl}
          suggestedName={`동영상.${mediaFileExtensionOf(manifest.mimeType)}`}
        />
      </figcaption>
    </figure>
  );
}

export function renderDiffArtifactPreview(payload: string): ReactNode {
  const lines = payload.replace(/\r\n/g, '\n').split('\n');
  const lineKeys = createStableStringKeys(lines, 'diff-line');
  return (
    <div style={artifactRendererPreviewStyles.diffPreview}>
      {lines.map((line, index) => (
        <div
          key={lineKeys[index] ?? `diff-line-${line}`}
          style={getDiffRowStyle(line)}
        >
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

export function renderTableArtifactPreview(payload: string): ReactNode {
  const rows = parseTableRows(payload);
  if (rows.length === 0) {
    return null;
  }

  const [header, ...body] = rows;
  if (!header) {
    return null;
  }
  const headerKeys = createStableStringKeys(header, 'table-header');
  const paddedBody = body.map((row) => padCells(row, header.length));
  const rowKeys = createStableStringKeys(
    paddedBody.map((row) => row.join('\u241f')),
    'table-row',
  );

  return (
    <div style={artifactRendererPreviewStyles.tableWrap}>
      <table style={artifactRendererPreviewStyles.table}>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={headerKeys[index] ?? `table-header-${cell}`}
                style={artifactRendererPreviewStyles.tableHeadCell}
              >
                {cell || ' '}
              </th>
            ))}
          </tr>
        </thead>
        {paddedBody.length > 0 ? (
          <tbody>
            {paddedBody.map((row, rowIndex) => {
              const rowKey = rowKeys[rowIndex] ?? `table-row-${rowIndex}`;
              const cellKeys = createStableStringKeys(row, `${rowKey}-cell`);
              return (
                <tr key={rowKey}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellKeys[cellIndex] ?? `${rowKey}-${cell}`}
                      style={getTableCellStyle(rowIndex)}
                    >
                      {cell || ' '}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

function getDiffLineStyle(line: string): CSSProperties {
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ')
  ) {
    return artifactRendererPreviewStyles.diffMeta;
  }
  if (line.startsWith('@@')) {
    return artifactRendererPreviewStyles.diffHunk;
  }
  if (line.startsWith('+')) {
    return artifactRendererPreviewStyles.diffAdded;
  }
  if (line.startsWith('-')) {
    return artifactRendererPreviewStyles.diffRemoved;
  }
  return {};
}

function getDiffRowStyle(line: string): CSSProperties {
  return {
    ...artifactRendererPreviewStyles.diffLine,
    ...getDiffLineStyle(line),
  };
}

function parseTableRows(payload: string): string[][] {
  return payload
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isMarkdownTableDivider(line))
    .map((line) => splitTableRow(line))
    .filter((cells) => cells.length > 0);
}

function splitTableRow(line: string): string[] {
  if (line.includes('|')) {
    return line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, cells) => {
        const isEdge =
          (index === 0 || index === cells.length - 1) && cell.length === 0;
        return !isEdge;
      });
  }
  if (line.includes('\t')) {
    return line.split('\t').map((cell) => cell.trim());
  }
  return [line];
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line);
}

function padCells(row: string[], width: number): string[] {
  if (row.length >= width) {
    return row;
  }
  return [...row, ...Array.from({ length: width - row.length }, () => '')];
}

function getTableCellStyle(rowIndex: number): CSSProperties {
  return {
    ...artifactRendererPreviewStyles.tableCell,
    background: rowIndex % 2 === 0 ? '#fffdf7' : '#fff8eb',
  };
}

function createStableStringKeys(
  values: readonly string[],
  prefix: string,
): string[] {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const baseKey = `${prefix}:${value}`;
    const nextCount = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, nextCount);
    return `${baseKey}:${nextCount}`;
  });
}
