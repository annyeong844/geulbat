const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 1.0;
const FIELD_WEIGHTS = {
  publicName: 6,
  family: 2,
  summary: 2,
  searchHint: 2,
  tag: 1,
  whenToUse: 2,
} as const;

export interface ToolSearchIndexCard {
  publicName: string;
  family: string;
  summary: string;
  searchHints: readonly string[];
  tags: readonly string[];
  whenToUse: string;
}

export type RankedToolSearchResult<TCard extends ToolSearchIndexCard> =
  TCard & {
    rank: number;
    score: number;
  };

export function summarizeToolDescription(description: string): string {
  const trimmed = description.trim();
  const sentenceEnd = trimmed.search(/[.!?](?:\s|$)/u);
  if (sentenceEnd < 0) {
    return trimmed;
  }
  return trimmed.slice(0, sentenceEnd + 1);
}

interface ToolSearchDocument<TCard extends ToolSearchIndexCard> {
  card: TCard;
  termFrequencies: Map<string, number>;
  length: number;
}

interface ToolSearchIndex<TCard extends ToolSearchIndexCard> {
  documents: ToolSearchDocument<TCard>[];
  averageLength: number;
  documentFrequencies: Map<string, number>;
}

export function searchRankedToolCatalog<TCard extends ToolSearchIndexCard>(
  query: string,
  catalog: readonly TCard[],
): RankedToolSearchResult<TCard>[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || catalog.length === 0) {
    return [];
  }

  const index = buildToolSearchIndex(catalog);
  const queryTermCounts = countQueryTerms(queryTerms);

  return index.documents
    .map((document) => ({
      card: document.card,
      score: scoreDocument(document, index, queryTermCounts),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return a.card.publicName.localeCompare(b.card.publicName);
    })
    .map((result, index) => ({
      rank: index + 1,
      score: Number(result.score.toFixed(6)),
      ...result.card,
    }));
}

function buildToolSearchIndex<TCard extends ToolSearchIndexCard>(
  catalog: readonly TCard[],
): ToolSearchIndex<TCard> {
  const documents = catalog.map((card) => buildSearchDocument(card));
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) /
      documents.length || 1;
  const documentFrequencies = countDocumentFrequencies(documents);
  return { documents, averageLength, documentFrequencies };
}

function buildSearchDocument<TCard extends ToolSearchIndexCard>(
  card: TCard,
): ToolSearchDocument<TCard> {
  const termFrequencies = new Map<string, number>();
  addWeightedTokens(termFrequencies, card.publicName, FIELD_WEIGHTS.publicName);
  addWeightedTokens(termFrequencies, card.family, FIELD_WEIGHTS.family);
  addWeightedTokens(termFrequencies, card.summary, FIELD_WEIGHTS.summary);
  addWeightedTokens(termFrequencies, card.whenToUse, FIELD_WEIGHTS.whenToUse);
  for (const hint of card.searchHints) {
    addWeightedTokens(termFrequencies, hint, FIELD_WEIGHTS.searchHint);
  }
  for (const tag of card.tags) {
    addWeightedTokens(termFrequencies, tag, FIELD_WEIGHTS.tag);
  }
  const length = Array.from(termFrequencies.values()).reduce(
    (sum, value) => sum + value,
    0,
  );
  return { card, termFrequencies, length };
}

function addWeightedTokens(
  termFrequencies: Map<string, number>,
  value: string,
  weight: number,
): void {
  for (const token of tokenize(value)) {
    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
  }
}

function tokenize(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function countQueryTerms(
  queryTerms: readonly string[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const term of queryTerms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function countDocumentFrequencies<TCard extends ToolSearchIndexCard>(
  documents: readonly ToolSearchDocument<TCard>[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document.termFrequencies.keys())) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

function scoreDocument<TCard extends ToolSearchIndexCard>(
  document: ToolSearchDocument<TCard>,
  index: ToolSearchIndex<TCard>,
  queryTermCounts: ReadonlyMap<string, number>,
): number {
  let score = 0;
  for (const [term, queryTermCount] of queryTermCounts) {
    const frequency = document.termFrequencies.get(term) ?? 0;
    if (frequency === 0) {
      continue;
    }
    const documentFrequency = index.documentFrequencies.get(term) ?? 0;
    const idf = Math.log(
      1 +
        (index.documents.length - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    const normalization =
      BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
    score +=
      queryTermCount *
      idf *
      ((frequency * (BM25_K1 + 1)) / (frequency + normalization) + BM25_DELTA);
  }
  return score;
}

export function buildGeneratedToolSearchRuntimeModuleSource(): string {
  return [
    `const BM25_K1 = ${JSON.stringify(BM25_K1)};`,
    `const BM25_B = ${JSON.stringify(BM25_B)};`,
    `const BM25_DELTA = ${JSON.stringify(BM25_DELTA)};`,
    `const FIELD_WEIGHTS = ${JSON.stringify(FIELD_WEIGHTS)};`,
    '',
    'export function searchRankedToolCatalog(query, catalog) {',
    '  const queryTerms = tokenize(query);',
    '  if (queryTerms.length === 0 || catalog.length === 0) {',
    '    return [];',
    '  }',
    '',
    '  const index = buildToolSearchIndex(catalog);',
    '  const queryTermCounts = countQueryTerms(queryTerms);',
    '  return index.documents',
    '    .map((document) => ({',
    '      card: document.card,',
    '      score: scoreDocument(document, index, queryTermCounts),',
    '    }))',
    '    .filter((result) => result.score > 0)',
    '    .sort((a, b) => {',
    '      const scoreDelta = b.score - a.score;',
    '      if (scoreDelta !== 0) {',
    '        return scoreDelta;',
    '      }',
    '      return a.card.publicName.localeCompare(b.card.publicName);',
    '    })',
    '    .map((result, index) => ({',
    '      rank: index + 1,',
    '      score: Number(result.score.toFixed(6)),',
    '      ...result.card,',
    '    }));',
    '}',
    '',
    'function buildToolSearchIndex(catalog) {',
    '  const documents = catalog.map((card) => buildSearchDocument(card));',
    '  const averageLength =',
    '    documents.reduce((sum, document) => sum + document.length, 0) /',
    '      documents.length || 1;',
    '  const documentFrequencies = countDocumentFrequencies(documents);',
    '  return { documents, averageLength, documentFrequencies };',
    '}',
    '',
    'function buildSearchDocument(card) {',
    '  const termFrequencies = new Map();',
    '  addWeightedTokens(termFrequencies, card.publicName, FIELD_WEIGHTS.publicName);',
    '  addWeightedTokens(termFrequencies, card.family, FIELD_WEIGHTS.family);',
    '  addWeightedTokens(termFrequencies, card.summary, FIELD_WEIGHTS.summary);',
    '  addWeightedTokens(termFrequencies, card.whenToUse, FIELD_WEIGHTS.whenToUse);',
    '  for (const hint of card.searchHints) {',
    '    addWeightedTokens(termFrequencies, hint, FIELD_WEIGHTS.searchHint);',
    '  }',
    '  for (const tag of card.tags) {',
    '    addWeightedTokens(termFrequencies, tag, FIELD_WEIGHTS.tag);',
    '  }',
    '  const length = Array.from(termFrequencies.values()).reduce(',
    '    (sum, value) => sum + value,',
    '    0,',
    '  );',
    '  return { card, termFrequencies, length };',
    '}',
    '',
    'function addWeightedTokens(termFrequencies, value, weight) {',
    '  for (const token of tokenize(value)) {',
    '    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);',
    '  }',
    '}',
    '',
    'function tokenize(value) {',
    '  return value',
    "    .normalize('NFKD')",
    "    .replace(/\\p{M}+/gu, '')",
    "    .replace(/(\\p{Lu}+)(\\p{Lu}\\p{Ll})/gu, '$1 $2')",
    "    .replace(/(\\p{Ll}|\\p{N})(\\p{Lu})/gu, '$1 $2')",
    "    .replace(/[^\\p{L}\\p{N}]+/gu, ' ')",
    '    .toLowerCase()',
    '    .trim()',
    '    .split(/\\s+/u)',
    '    .filter((token) => token.length > 0);',
    '}',
    '',
    'function countQueryTerms(queryTerms) {',
    '  const counts = new Map();',
    '  for (const term of queryTerms) {',
    '    counts.set(term, (counts.get(term) ?? 0) + 1);',
    '  }',
    '  return counts;',
    '}',
    '',
    'function countDocumentFrequencies(documents) {',
    '  const counts = new Map();',
    '  for (const document of documents) {',
    '    for (const term of new Set(document.termFrequencies.keys())) {',
    '      counts.set(term, (counts.get(term) ?? 0) + 1);',
    '    }',
    '  }',
    '  return counts;',
    '}',
    '',
    'function scoreDocument(document, index, queryTermCounts) {',
    '  let score = 0;',
    '  for (const [term, queryTermCount] of queryTermCounts) {',
    '    const frequency = document.termFrequencies.get(term) ?? 0;',
    '    if (frequency === 0) {',
    '      continue;',
    '    }',
    '    const documentFrequency = index.documentFrequencies.get(term) ?? 0;',
    '    const idf = Math.log(',
    '      1 +',
    '        (index.documents.length - documentFrequency + 0.5) /',
    '          (documentFrequency + 0.5),',
    '    );',
    '    const normalization =',
    '      BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));',
    '    score +=',
    '      queryTermCount *',
    '      idf *',
    '      ((frequency * (BM25_K1 + 1)) / (frequency + normalization) + BM25_DELTA);',
    '  }',
    '  return score;',
    '}',
    '',
  ].join('\n');
}
