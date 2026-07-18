import type { CSSProperties, ReactNode } from 'react';
import type {
  ImageArtifactPayloadV1,
  VideoArtifactPayloadV1,
} from '@geulbat/protocol/artifacts';

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

const imagePreviewStyles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    borderRadius: 8,
    background: 'var(--surface-container-lowest)',
    boxShadow: 'var(--elev-card)',
    padding: 12,
  },
  image: {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: 6,
    alignSelf: 'center',
  },
  caption: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--on-surface-muted)',
    fontFamily: 'var(--font-ui-label)',
    wordBreak: 'break-word',
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
        ? `/api/threads/${encodeURIComponent(threadId)}/media/${encodeURIComponent(manifest.source.mediaRef)}`
        : null;
  if (src === null) {
    // thread_media인데 스레드 스코프를 모르면 잘못된 URL 대신 캡션만
    return (
      <figure style={imagePreviewStyles.wrap}>
        <figcaption style={imagePreviewStyles.caption}>
          {caption} — {provenance.model}
        </figcaption>
      </figure>
    );
  }
  return (
    <figure style={imagePreviewStyles.wrap}>
      <img style={imagePreviewStyles.image} src={src} alt={provenance.prompt} />
      <figcaption style={imagePreviewStyles.caption}>
        {caption} — {provenance.model}
      </figcaption>
    </figure>
  );
}

// 동영상 미리보기(video-generation-open §3/D-V6) — 인라인 재생이 1급이고
// 저장은 선택 링크다. 바이트는 인증 media 라우트가 Range로 스트리밍한다.
const videoPreviewStyles = {
  video: {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: 6,
    alignSelf: 'center',
  },
  captionRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
  },
  saveLink: {
    fontSize: 12,
    color: 'var(--on-surface-muted)',
    whiteSpace: 'nowrap',
    textDecoration: 'underline',
  },
} satisfies Record<string, CSSProperties>;

// VideoArtifactPayloadV1 owns a media reference but no caption-track reference.
// Do not add an empty track that would falsely claim captions are available.
/* oxlint-disable jsx-a11y/media-has-caption */
export function renderVideoArtifactPreview(
  manifest: VideoArtifactPayloadV1,
  threadId: string,
): ReactNode {
  const { provenance } = manifest;
  const mediaUrl = `/api/threads/${encodeURIComponent(threadId)}/media/${encodeURIComponent(manifest.source.mediaRef)}`;
  const durationLabel =
    manifest.durationSeconds !== undefined
      ? ` · ${manifest.durationSeconds}초`
      : '';
  return (
    <figure style={imagePreviewStyles.wrap}>
      <video
        style={videoPreviewStyles.video}
        src={mediaUrl}
        controls
        preload="metadata"
      />
      <figcaption
        style={{
          ...imagePreviewStyles.caption,
          ...videoPreviewStyles.captionRow,
        }}
      >
        <span>
          {provenance.prompt} — {provenance.model}
          {durationLabel}
        </span>
        <a
          style={videoPreviewStyles.saveLink}
          href={mediaUrl}
          download={manifest.source.mediaRef}
        >
          저장
        </a>
      </figcaption>
    </figure>
  );
}
/* oxlint-enable jsx-a11y/media-has-caption */

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
