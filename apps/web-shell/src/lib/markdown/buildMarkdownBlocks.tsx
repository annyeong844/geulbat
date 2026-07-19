import { memo, PureComponent, type ReactElement, type ReactNode } from 'react';
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
const PREPARED_MARKDOWN_BY_OWNER = new WeakMap<
  object,
  Map<string, ReactElement>
>();

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

export function buildMarkdownBlocks(
  markdown: string,
  renderCacheOwner?: object,
): ReactNode[] {
  return [
    <IncrementalMarkdown
      key="markdown"
      markdown={markdown}
      {...(renderCacheOwner !== undefined ? { renderCacheOwner } : {})}
    />,
  ];
}

export function prepareMarkdownBlocks(
  renderCacheOwner: object,
  markdown: string,
): void {
  readPreparedMarkdown(renderCacheOwner, markdown);
}

interface MarkdownSourceNode {
  key: string;
  startOffset: number;
  source: string;
  isDefinition: boolean;
}

interface MarkdownSourceProjection {
  markdown: string;
  stableContentNodes: MarkdownSourceNode[];
  stableDefinitionSources: string[];
  tailNode: MarkdownSourceNode | null;
}

class IncrementalMarkdown extends PureComponent<
  { markdown: string; renderCacheOwner?: object },
  { projection: MarkdownSourceProjection; hasUpdated: boolean }
> {
  state: { projection: MarkdownSourceProjection; hasUpdated: boolean } =
    this.props.renderCacheOwner === undefined
      ? {
          projection: projectMarkdownSource(this.props.markdown, null),
          hasUpdated: true,
        }
      : {
          projection: {
            markdown: this.props.markdown,
            stableContentNodes: [],
            stableDefinitionSources: [],
            tailNode: null,
          },
          hasUpdated: false,
        };

  static getDerivedStateFromProps(
    props: { markdown: string; renderCacheOwner?: object },
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
      return (
        <MarkdownBlock
          markdown={this.props.markdown}
          {...(this.props.renderCacheOwner !== undefined
            ? { renderCacheOwner: this.props.renderCacheOwner }
            : {})}
        />
      );
    }

    const { stableContentNodes, stableDefinitionSources, tailNode } =
      this.state.projection;
    const definitions = [
      ...stableDefinitionSources,
      ...(tailNode?.isDefinition === true ? [tailNode.source] : []),
    ].join('\n\n');

    return (
      <>
        <StableMarkdownBlocks
          nodes={stableContentNodes}
          definitions={definitions}
          {...(this.props.renderCacheOwner !== undefined
            ? { renderCacheOwner: this.props.renderCacheOwner }
            : {})}
        />
        {tailNode !== null && !tailNode.isDefinition ? (
          <MarkdownBlock
            key={tailNode.key}
            markdown={
              definitions
                ? `${tailNode.source}\n\n${definitions}`
                : tailNode.source
            }
            {...(this.props.renderCacheOwner !== undefined
              ? { renderCacheOwner: this.props.renderCacheOwner }
              : {})}
          />
        ) : null}
      </>
    );
  }
}

const StableMarkdownBlocks = memo(function StableMarkdownBlocks(props: {
  nodes: MarkdownSourceNode[];
  definitions: string;
  renderCacheOwner?: object;
}) {
  return props.nodes.map((node) => (
    <MarkdownBlock
      key={node.key}
      markdown={
        props.definitions
          ? `${node.source}\n\n${props.definitions}`
          : node.source
      }
      {...(props.renderCacheOwner !== undefined
        ? { renderCacheOwner: props.renderCacheOwner }
        : {})}
    />
  ));
});

const MarkdownBlock = memo(function MarkdownBlock(props: {
  markdown: string;
  renderCacheOwner?: object;
}) {
  const rendered =
    props.renderCacheOwner === undefined
      ? renderMarkdown(props.markdown)
      : readPreparedMarkdown(props.renderCacheOwner, props.markdown);
  return <div className="rendered-markdown">{rendered}</div>;
});

function readPreparedMarkdown(
  renderCacheOwner: object,
  markdown: string,
): ReactElement {
  let preparedByMarkdown = PREPARED_MARKDOWN_BY_OWNER.get(renderCacheOwner);
  if (preparedByMarkdown === undefined) {
    preparedByMarkdown = new Map();
    PREPARED_MARKDOWN_BY_OWNER.set(renderCacheOwner, preparedByMarkdown);
  }
  const prepared = preparedByMarkdown.get(markdown);
  if (prepared !== undefined) {
    return prepared;
  }
  const next = renderMarkdown(markdown);
  preparedByMarkdown.set(markdown, next);
  return next;
}

function renderMarkdown(markdown: string): ReactElement {
  return ReactMarkdown({
    remarkPlugins: REMARK_PLUGINS,
    components: MARKDOWN_COMPONENTS,
    skipHtml: true,
    urlTransform: transformMarkdownUrl,
    children: markdown,
  });
}

function projectMarkdownSource(
  markdown: string,
  previous: MarkdownSourceProjection | null,
): MarkdownSourceProjection {
  if (
    previous === null ||
    previous.tailNode === null ||
    !markdown.startsWith(previous.markdown)
  ) {
    return createMarkdownSourceProjection(
      markdown,
      parseMarkdownSourceNodes(markdown, 0),
    );
  }

  const parsedTail = parseMarkdownSourceNodes(
    markdown.slice(previous.tailNode.startOffset),
    previous.tailNode.startOffset,
  );
  if (parsedTail.length === 0) {
    return createMarkdownSourceProjection(
      markdown,
      parseMarkdownSourceNodes(markdown, 0),
    );
  }

  const promotedNodes = parsedTail.slice(0, -1);
  const promotedContentNodes = promotedNodes.filter(
    (node) => !node.isDefinition,
  );
  const promotedDefinitionSources = promotedNodes
    .filter((node) => node.isDefinition)
    .map((node) => node.source);
  return {
    markdown,
    stableContentNodes:
      promotedContentNodes.length === 0
        ? previous.stableContentNodes
        : [...previous.stableContentNodes, ...promotedContentNodes],
    stableDefinitionSources:
      promotedDefinitionSources.length === 0
        ? previous.stableDefinitionSources
        : [...previous.stableDefinitionSources, ...promotedDefinitionSources],
    tailNode: parsedTail.at(-1) ?? null,
  };
}

function createMarkdownSourceProjection(
  markdown: string,
  nodes: MarkdownSourceNode[],
): MarkdownSourceProjection {
  const stableNodes = nodes.slice(0, -1);
  return {
    markdown,
    stableContentNodes: stableNodes.filter((node) => !node.isDefinition),
    stableDefinitionSources: stableNodes
      .filter((node) => node.isDefinition)
      .map((node) => node.source),
    tailNode: nodes.at(-1) ?? null,
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
