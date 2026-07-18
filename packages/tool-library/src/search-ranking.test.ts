import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGeneratedToolSearchRuntimeModuleSource,
  searchRankedToolCatalog,
  summarizeToolDescription,
  type ToolSearchIndexCard,
} from './search-ranking.js';

void test('searchRankedToolCatalog ranks weighted BM25 catalog fields deterministically', () => {
  const catalog: readonly ToolSearchIndexCard[] = [
    {
      publicName: 'fetch_url',
      family: 'network',
      summary: 'Fetch one public URL.',
      searchHints: ['open url', 'read website'],
      tags: ['network'],
      whenToUse: 'Fetch one known URL when no search is needed.',
    },
    {
      publicName: 'read_file',
      family: 'file',
      summary: 'Read a workspace file.',
      searchHints: ['cat file'],
      tags: ['file'],
      whenToUse: 'Read file contents from a known path.',
    },
    {
      publicName: 'tool_search',
      family: 'catalog',
      summary: 'Search the available tool catalog.',
      searchHints: ['find tool'],
      tags: ['tool', 'catalog'],
      whenToUse: 'Find the tool that matches an intended action.',
    },
  ];

  assert.deepEqual(
    searchRankedToolCatalog('open url', catalog).map(
      (result) => result.publicName,
    ),
    ['fetch_url'],
  );
  assert.deepEqual(
    searchRankedToolCatalog('cat file', catalog).map(
      (result) => result.publicName,
    ),
    ['read_file'],
  );
});

void test('searchRankedToolCatalog tokenizes camelCase and acronyms', () => {
  const catalog: readonly ToolSearchIndexCard[] = [
    {
      publicName: 'readHTTPResponse',
      family: 'network',
      summary: 'Inspect an HTTP response body.',
      searchHints: [],
      tags: ['network'],
      whenToUse: 'Inspect an HTTP response body from a URL.',
    },
    {
      publicName: 'read_notes',
      family: 'file',
      summary: 'Read a note file.',
      searchHints: [],
      tags: ['file'],
      whenToUse: 'Read a note file.',
    },
  ];

  assert.equal(
    searchRankedToolCatalog('http response', catalog)[0]?.publicName,
    'readHTTPResponse',
  );
});

void test('summarizeToolDescription keeps the first sentence only', () => {
  assert.equal(
    summarizeToolDescription('Read a file. Use offsets for paging.'),
    'Read a file.',
  );
  assert.equal(summarizeToolDescription('No period here'), 'No period here');
});

void test('buildGeneratedToolSearchRuntimeModuleSource emits a standalone BM25 runtime', () => {
  const source = buildGeneratedToolSearchRuntimeModuleSource();

  assert.equal(
    source.includes('export function searchRankedToolCatalog'),
    true,
  );
  assert.equal(source.includes('const BM25_K1 = 1.2;'), true);
  assert.equal(source.includes('whenToUse'), true);
  assert.equal(source.includes('import '), false);
});

void test('generated BM25 runtime matches package ranking results', async () => {
  const catalog: readonly ToolSearchIndexCard[] = [
    {
      publicName: 'exec_command',
      family: 'command',
      summary: 'Run a shell command.',
      searchHints: ['shell command', 'terminal command'],
      tags: ['shell', 'command'],
      whenToUse: 'Run host commands when direct command execution is needed.',
    },
    {
      publicName: 'fetch_url',
      family: 'network',
      summary: 'Fetch one public URL.',
      searchHints: ['open url', 'read website'],
      tags: ['network'],
      whenToUse: 'Fetch one known URL when no search is needed.',
    },
    {
      publicName: 'read_file',
      family: 'file',
      summary: 'Read a workspace file.',
      searchHints: ['cat file'],
      tags: ['file'],
      whenToUse: 'Read file contents from a known path.',
    },
  ];
  const source = buildGeneratedToolSearchRuntimeModuleSource();
  const runtimeModule = (await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  )) as {
    searchRankedToolCatalog(
      query: string,
      cards: readonly ToolSearchIndexCard[],
    ): ReturnType<typeof searchRankedToolCatalog>;
  };

  for (const query of ['shell command', 'open url', 'cat file']) {
    assert.deepEqual(
      runtimeModule.searchRankedToolCatalog(query, catalog),
      searchRankedToolCatalog(query, catalog),
    );
  }
});
