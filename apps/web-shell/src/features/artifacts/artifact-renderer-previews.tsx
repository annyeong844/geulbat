import { type CSSProperties, type ReactNode } from 'react';

const artifactRendererPreviewStyles = {
  codePreview: {
    margin: 0,
    padding: '14px 16px',
    background: 'linear-gradient(180deg, #1f2228 0%, #15181d 100%)',
    color: '#f8f4ea',
    borderRadius: 12,
    overflowX: 'auto',
    fontSize: 12,
    lineHeight: 1.55,
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  },
  diffPreview: {
    margin: 0,
    borderRadius: 12,
    overflow: 'hidden',
    border: '1px solid #d6dce5',
    background: '#fbfcfe',
    fontSize: 12,
    lineHeight: 1.55,
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    boxShadow: '0 6px 14px rgba(52, 73, 94, 0.08)',
  },
  diffLine: {
    padding: '4px 12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  diffAdded: {
    background: '#e7f6ec',
    color: '#1e4620',
  },
  diffRemoved: {
    background: '#fdecea',
    color: '#7b241c',
  },
  diffHunk: {
    background: '#eef4ff',
    color: '#2b4c7e',
  },
  diffMeta: {
    background: '#f5f6f8',
    color: '#586069',
  },
  tableWrap: {
    overflowX: 'auto',
    borderRadius: 12,
    border: '1px solid #e2d6bc',
    background: '#fffef9',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    lineHeight: 1.5,
    background: '#fffdf7',
  },
  tableHeadCell: {
    padding: '8px 10px',
    textAlign: 'left',
    borderBottom: '1px solid #d6dce5',
    background: '#f3eee2',
    color: '#4f3818',
    fontWeight: 700,
  },
  tableCell: {
    padding: '8px 10px',
    borderBottom: '1px solid #ece7da',
    color: '#3b2f1e',
    verticalAlign: 'top',
  },
} satisfies Record<string, CSSProperties>;

export function renderCodeArtifactPreview(payload: string): ReactNode {
  return <pre style={artifactRendererPreviewStyles.codePreview}>{payload}</pre>;
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
