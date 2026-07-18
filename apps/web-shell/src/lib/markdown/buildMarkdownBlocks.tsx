import { memo, PureComponent, type ReactNode } from 'react';
import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
} from 'react-markdown';
import type { Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const REMARK_GFM_OPTIONS = { singleTilde: false } as const;
const REMARK_PLUGINS = [
  [remarkGfm, REMARK_GFM_OPTIONS],
] satisfies ReactMarkdownOptions['remarkPlugins'];
const MARKDOWN_SOURCE_PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm, REMARK_GFM_OPTIONS);

const MARKDOWN_COMPONENTS = {
  a({ children, href, title }) {
    if (!href) {
      return (
        <span className="rendered-markdown-blocked-link" title={title}>
          {children}
        </span>
      );
    }
    const isFragment = href.startsWith('#');
    return (
      <a
        className="rendered-markdown-link"
        href={href}
        title={title}
        target={isFragment ? undefined : '_blank'}
        rel={isFragment ? undefined : 'noopener noreferrer'}
      >
        {children}
      </a>
    );
  },
  code({ children, className }) {
    return (
      <code
        className={
          className
            ? `rendered-markdown-code ${className}`
            : 'rendered-markdown-code'
        }
      >
        {children}
      </code>
    );
  },
  img({ alt, title }) {
    return alt ? (
      <span className="rendered-markdown-image-alt" title={title}>
        {alt}
      </span>
    ) : null;
  },
  pre({ children }) {
    return <pre className="rendered-markdown-code-block">{children}</pre>;
  },
  table({ children }) {
    return (
      <div className="rendered-markdown-table-scroll">
        <table className="rendered-markdown-table">{children}</table>
      </div>
    );
  },
} satisfies Components;

export function buildMarkdownBlocks(markdown: string): ReactNode[] {
  return [<IncrementalMarkdown key="markdown" markdown={markdown} />];
}

interface MarkdownSourceNode {
  key: string;
  startOffset: number;
  source: string;
  isDefinition: boolean;
}

interface MarkdownSourceProjection {
  markdown: string;
  nodes: MarkdownSourceNode[];
}

class IncrementalMarkdown extends PureComponent<
  { markdown: string },
  { projection: MarkdownSourceProjection; hasUpdated: boolean }
> {
  state: { projection: MarkdownSourceProjection; hasUpdated: boolean } = {
    projection: { markdown: this.props.markdown, nodes: [] },
    hasUpdated: false,
  };

  static getDerivedStateFromProps(
    props: { markdown: string },
    state: { projection: MarkdownSourceProjection; hasUpdated: boolean },
  ) {
    if (props.markdown === state.projection.markdown) {
      return null;
    }
    return {
      projection: projectMarkdownSource(props.markdown, state.projection),
      hasUpdated: true,
    };
  }

  render() {
    if (!this.state.hasUpdated) {
      return <MarkdownBlock markdown={this.props.markdown} />;
    }

    const definitions = this.state.projection.nodes
      .filter((node) => node.isDefinition)
      .map((node) => node.source)
      .join('\n\n');

    return this.state.projection.nodes
      .filter((node) => !node.isDefinition)
      .map((node) => (
        <MarkdownBlock
          key={node.key}
          markdown={
            definitions ? `${node.source}\n\n${definitions}` : node.source
          }
        />
      ));
  }
}

const MarkdownBlock = memo(function MarkdownBlock(props: { markdown: string }) {
  return (
    <div className="rendered-markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        skipHtml
        urlTransform={transformMarkdownUrl}
      >
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
});

function projectMarkdownSource(
  markdown: string,
  previous: MarkdownSourceProjection | null,
): MarkdownSourceProjection {
  if (
    previous === null ||
    previous.nodes.length === 0 ||
    !markdown.startsWith(previous.markdown)
  ) {
    return {
      markdown,
      nodes: parseMarkdownSourceNodes(markdown, 0),
    };
  }

  const previousTail = previous.nodes.at(-1)!;
  const stableNodes = previous.nodes.slice(0, -1);
  return {
    markdown,
    nodes: [
      ...stableNodes,
      ...parseMarkdownSourceNodes(
        markdown.slice(previousTail.startOffset),
        previousTail.startOffset,
      ),
    ],
  };
}

function parseMarkdownSourceNodes(
  markdown: string,
  sourceOffset: number,
): MarkdownSourceNode[] {
  const root = MARKDOWN_SOURCE_PROCESSOR.parse(markdown) as Root;
  return root.children.map((node) => {
    const relativeStartOffset = readMarkdownNodeStartOffset(node);
    const relativeEndOffset = readMarkdownNodeEndOffset(node);
    const startOffset = sourceOffset + relativeStartOffset;
    return {
      key: `${node.type}:${startOffset}`,
      startOffset,
      source: markdown.slice(relativeStartOffset, relativeEndOffset),
      isDefinition: isReferenceDefinition(node),
    };
  });
}

function isReferenceDefinition(
  node: RootContent,
): node is Extract<RootContent, { type: 'definition' | 'footnoteDefinition' }> {
  return node.type === 'definition' || node.type === 'footnoteDefinition';
}

function readMarkdownNodeEndOffset(node: RootContent): number {
  const endOffset = node.position?.end.offset;
  if (endOffset === undefined) {
    throw new Error('Markdown parser did not provide a source end offset');
  }
  return endOffset;
}

function readMarkdownNodeStartOffset(node: RootContent): number {
  const startOffset = node.position?.start.offset;
  if (startOffset === undefined) {
    throw new Error('Markdown parser did not provide a source start offset');
  }
  return startOffset;
}

function transformMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('#')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:'
      ? trimmed
      : '';
  } catch {
    return '';
  }
}
