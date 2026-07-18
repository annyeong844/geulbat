import { readFile } from 'node:fs/promises';

interface PtcStaticImportEdge {
  sourcePath: string;
  specifier: string;
  statementKind: 'import' | 'export';
  typeOnly: boolean;
}

type PtcStaticImportGraph = Map<string, PtcStaticImportEdge[]>;

const PTC_SOURCE_ROOT_URL = new URL('../../src/daemon/ptc/', import.meta.url);
const STATIC_IMPORT_PATTERN =
  /\b(?<statementKind>import|export)\s+(?<typeOnly>type\s+)?(?:(?:[^'"]*?\s+from\s+)|)['"](?<specifier>[^'"]+)['"]/gu;

export function ptcSourceUrl(sourcePath: string): URL {
  return new URL(sourcePath, PTC_SOURCE_ROOT_URL);
}

export async function readPtcStaticImportEdges(
  sourceUrl: URL,
): Promise<PtcStaticImportEdge[]> {
  const source = await readFile(sourceUrl, 'utf8');
  return [...source.matchAll(STATIC_IMPORT_PATTERN)].map((match) => ({
    sourcePath: sourceUrl.pathname,
    specifier: match.groups?.specifier ?? '',
    statementKind:
      match.groups?.statementKind === 'export' ? 'export' : 'import',
    typeOnly: match.groups?.typeOnly !== undefined,
  }));
}

export async function collectPtcStaticImportGraph(
  entryUrl: URL,
): Promise<PtcStaticImportGraph> {
  const visited = new Set<string>();
  const graph: PtcStaticImportGraph = new Map();

  async function visit(sourceUrl: URL): Promise<void> {
    const sourcePath = sourceUrl.pathname;
    if (visited.has(sourcePath)) {
      return;
    }
    visited.add(sourcePath);

    const edges = await readPtcStaticImportEdges(sourceUrl);
    graph.set(sourcePath, edges);

    for (const edge of edges) {
      if (!edge.specifier.startsWith('.')) {
        continue;
      }
      const childUrl = resolvePtcStaticImportUrl(sourceUrl, edge.specifier);
      if (childUrl.pathname.startsWith(PTC_SOURCE_ROOT_URL.pathname)) {
        await visit(childUrl);
      }
    }
  }

  await visit(entryUrl);
  return graph;
}

export function ptcStaticImportGraphIncludesSource(
  graph: PtcStaticImportGraph,
  sourcePathSuffix: string,
): boolean {
  return [...graph.keys()].some((sourcePath) =>
    sourcePath.endsWith(sourcePathSuffix),
  );
}

export function ptcStaticImportGraphIncludesSpecifier(
  graph: PtcStaticImportGraph,
  specifier: string,
): boolean {
  return [...graph.values()].some((edges) =>
    edges.some((edge) => edge.specifier === specifier),
  );
}

export function readPtcStaticImportSpecifiers(
  graph: PtcStaticImportGraph,
  sourceUrl: URL,
): string[] {
  return (graph.get(sourceUrl.pathname) ?? []).map((edge) => edge.specifier);
}

function resolvePtcStaticImportUrl(sourceUrl: URL, specifier: string): URL {
  const sourceSpecifier = specifier.endsWith('.js')
    ? `${specifier.slice(0, -3)}.ts`
    : specifier;
  return new URL(sourceSpecifier, sourceUrl);
}
