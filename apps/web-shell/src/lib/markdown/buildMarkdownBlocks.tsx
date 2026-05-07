import { type CSSProperties, type ReactNode } from 'react';

interface MarkdownBlockParseContext {
  lines: readonly string[];
  index: number;
  blockIndex: number;
}

interface MarkdownBlockParseResult {
  block: ReactNode;
  nextIndex: number;
}

type MarkdownBlockParser = (
  context: MarkdownBlockParseContext,
) => MarkdownBlockParseResult | null;

const MARKDOWN_BLOCK_PARSERS: readonly MarkdownBlockParser[] = [
  parseCodeFenceBlock,
  parseHeadingBlock,
  parseQuoteBlock,
  parseListBlock,
];

export function buildMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const parsed = parseMarkdownBlock({
      lines,
      index: i,
      blockIndex: blocks.length,
    });
    blocks.push(parsed.block);
    i = parsed.nextIndex;
  }

  return blocks;
}

function parseMarkdownBlock(
  context: MarkdownBlockParseContext,
): MarkdownBlockParseResult {
  for (const parseBlock of MARKDOWN_BLOCK_PARSERS) {
    const result = parseBlock(context);
    if (result) {
      return result;
    }
  }

  return parseParagraphBlock(context);
}

function parseCodeFenceBlock({
  lines,
  index,
  blockIndex,
}: MarkdownBlockParseContext): MarkdownBlockParseResult | null {
  const fenceMarker = readFenceMarker(lines[index] ?? '');
  if (!fenceMarker) {
    return null;
  }

  const codeLines: string[] = [];
  let nextIndex = index + 1;
  while (
    nextIndex < lines.length &&
    (lines[nextIndex] ?? '').trim() !== fenceMarker
  ) {
    codeLines.push(lines[nextIndex] ?? '');
    nextIndex += 1;
  }
  if (
    nextIndex < lines.length &&
    (lines[nextIndex] ?? '').trim() === fenceMarker
  ) {
    nextIndex += 1;
  }

  return {
    block: (
      <pre key={`code-${blockIndex}`} style={markdownStyles.codeBlock}>
        {codeLines.join('\n')}
      </pre>
    ),
    nextIndex,
  };
}

function parseHeadingBlock({
  lines,
  index,
  blockIndex,
}: MarkdownBlockParseContext): MarkdownBlockParseResult | null {
  const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index] ?? '');
  if (!heading) {
    return null;
  }

  const marker = heading[1];
  if (!marker) {
    return null;
  }

  const text = heading[2] ?? '';
  const level = marker.length;
  const size = Math.max(18 - level * 2, 12);

  return {
    block: (
      <div key={`heading-${blockIndex}`} style={getHeadingStyle(size)}>
        {text}
      </div>
    ),
    nextIndex: index + 1,
  };
}

function parseQuoteBlock({
  lines,
  index,
  blockIndex,
}: MarkdownBlockParseContext): MarkdownBlockParseResult | null {
  if (!isQuoteLine(lines[index] ?? '')) {
    return null;
  }

  const quoteLines: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length && isQuoteLine(lines[nextIndex] ?? '')) {
    quoteLines.push((lines[nextIndex] ?? '').replace(/^>\s?/, ''));
    nextIndex += 1;
  }

  return {
    block: (
      <blockquote key={`quote-${blockIndex}`} style={markdownStyles.quoteBlock}>
        {quoteLines.join('\n')}
      </blockquote>
    ),
    nextIndex,
  };
}

function parseListBlock({
  lines,
  index,
  blockIndex,
}: MarkdownBlockParseContext): MarkdownBlockParseResult | null {
  if (!isListItemLine(lines[index] ?? '')) {
    return null;
  }

  const items: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length && isListItemLine(lines[nextIndex] ?? '')) {
    items.push((lines[nextIndex] ?? '').replace(/^[-*]\s+/, ''));
    nextIndex += 1;
  }
  const itemKeys = createStableStringKeys(items, 'list-item');

  return {
    block: (
      <ul key={`list-${blockIndex}`} style={markdownStyles.list}>
        {items.map((item, itemIndex) => (
          <li
            key={itemKeys[itemIndex] ?? `list-item-${item}`}
            style={markdownStyles.listItem}
          >
            {item}
          </li>
        ))}
      </ul>
    ),
    nextIndex,
  };
}

function parseParagraphBlock({
  lines,
  index,
  blockIndex,
}: MarkdownBlockParseContext): MarkdownBlockParseResult {
  const paragraphLines: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length) {
    const candidate = lines[nextIndex] ?? '';
    if (isBlockBoundaryLine(candidate)) {
      break;
    }
    paragraphLines.push(candidate);
    nextIndex += 1;
  }

  return {
    block: (
      <p key={`paragraph-${blockIndex}`} style={markdownStyles.paragraph}>
        {paragraphLines.join(' ')}
      </p>
    ),
    nextIndex,
  };
}

const markdownStyles = {
  codeBlock: {
    padding: '10px 12px',
    background: '#1f1f1f',
    color: '#f5f5f5',
    borderRadius: 4,
    overflowX: 'auto',
    fontSize: 12,
    marginBottom: 10,
  },
  quoteBlock: {
    margin: '0 0 10px 0',
    padding: '6px 10px',
    borderLeft: '3px solid #c8baa0',
    color: '#625746',
    background: '#faf5e8',
  },
  list: {
    margin: '0 0 10px 18px',
  },
  listItem: {
    marginBottom: 4,
  },
  paragraph: {
    marginBottom: 10,
    lineHeight: 1.55,
  },
} satisfies Record<string, CSSProperties>;

function getHeadingStyle(size: number): CSSProperties {
  return {
    fontWeight: 700,
    fontSize: size,
    marginBottom: 8,
    color: '#3b2f1e',
  };
}

function readFenceMarker(line: string): string | null {
  const match = /^(?<marker>`{3,}|~{3,})/.exec(line);
  return match?.groups?.['marker'] ?? null;
}

function isQuoteLine(line: string): boolean {
  return /^>\s?/.test(line);
}

function isListItemLine(line: string): boolean {
  return /^[-*]\s+/.test(line);
}

function isBlockBoundaryLine(line: string): boolean {
  return (
    !line.trim() ||
    readFenceMarker(line) !== null ||
    /^(#{1,6})\s+/.test(line) ||
    isQuoteLine(line) ||
    isListItemLine(line)
  );
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
