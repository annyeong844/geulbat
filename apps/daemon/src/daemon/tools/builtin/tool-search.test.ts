import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinToolRegistryStore } from './catalog.js';
import {
  buildToolSearchCatalog,
  createToolSearchTool,
  searchToolCatalog,
  type ToolSearchCatalogCard,
} from './tool-search.js';
import {
  isToolObjectParameters,
  type AnyTool,
  type ToolExecutionContext,
} from '../types.js';
import { createToolLibraryProjectionPort } from '../tool-library-projection.js';
import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';

void test('tool_search exposes catalog-only scalar query schema', () => {
  const registry = createBuiltinToolRegistryStore();
  const tool = createToolSearchTool({
    getCatalog: () => buildToolSearchCatalog(readRegisteredTools(registry)),
  });

  assert.equal(tool.description.includes('does not execute tools'), true);
  assert.equal(tool.sideEffectLevel, 'none');
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.mayMutateComputerFiles, false);
  assert.ok(isToolObjectParameters(tool.parameters));
  assert.deepEqual(tool.parameters.required, ['query']);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query']);
});

void test('buildToolSearchCatalog derives cards from current tool definitions', () => {
  const registry = createBuiltinToolRegistryStore();
  const readFileTool = registry.getTool('read_file');
  assert.ok(readFileTool?.catalogSearchMetadata);
  assert.equal(
    readFileTool.catalogSearchMetadata.searchHints.includes('cat file'),
    true,
  );

  const catalog = buildToolSearchCatalog(readRegisteredTools(registry));
  const readFile = catalog.find((card) => card.publicName === 'read_file');
  const toolSearch = catalog.find((card) => card.publicName === 'tool_search');

  assert.ok(readFile);
  assert.equal(readFile.signatureRef, buildToolSignatureRef('read_file'));
  assert.equal(readFile.family, 'file');
  assert.equal(readFile.approvalClass, 'approval_free');
  assert.equal(readFile.sideEffectLevel, 'read');
  assert.equal(readFile.mayMutateComputerFiles, false);
  assert.equal(readFile.searchHints.includes('cat file'), true);

  assert.ok(toolSearch);
  assert.equal(toolSearch.family, 'catalog');
  assert.equal(toolSearch.sideEffectLevel, 'none');
  assert.equal(toolSearch.notFor.includes('Executing'), true);

  assert.deepEqual([...new Set(catalog.map((card) => card.family))].sort(), [
    'agent',
    'browser',
    'catalog',
    'command',
    'file',
    'memory',
    'network',
    'planning',
    'presentation',
    'ptc',
    'tool_output',
  ]);

  for (const card of catalog) {
    assert.notDeepEqual(card.searchHints, [], card.publicName);
    assert.notEqual(
      card.notFor,
      'Unavailable behavior must be handled by another registered tool.',
      card.publicName,
    );
  }
});

void test('searchToolCatalog ranks familiar BM25 intents deterministically', () => {
  const catalog = buildToolSearchCatalog(
    readRegisteredTools(createBuiltinToolRegistryStore()),
  );

  assert.equal(firstSearchResult('cat file', catalog), 'read_file');
  assert.equal(firstSearchResult('shell command', catalog), 'exec_command');
  assert.equal(firstSearchResult('ls folder', catalog), 'list_files');
  assert.equal(firstSearchResult('grep text', catalog), 'search_files');
  assert.equal(firstSearchResult('open url', catalog), 'fetch_url');
  assert.equal(firstSearchResult('large output', catalog), 'read_tool_output');
  assert.equal(firstSearchResult('patch', catalog), 'apply_patch');
  assert.equal(firstSearchResult('rename file', catalog), 'manage_files');
  assert.equal(firstSearchResult('task list', catalog), 'update_plan');
  assert.equal(firstSearchResult('spawn subagent', catalog), 'agent_spawn');
  assert.equal(
    firstSearchResult('message subagent', catalog),
    'agent_send_input',
  );
  assert.equal(firstSearchResult('stop subagent', catalog), 'agent_stop');
  assert.equal(firstSearchResult('wait for agent', catalog), 'agent_wait');
  assert.equal(
    firstSearchResult('refresh memory', catalog),
    'refresh_memory_index',
  );
  assert.equal(
    firstSearchResult('search memory', catalog),
    'search_memory_index',
  );
  assert.equal(
    firstSearchResult('browser navigate', catalog),
    'browser_navigate',
  );
  assert.equal(
    firstSearchResult('page load evidence', catalog),
    'browser_page_load_evidence',
  );
  assert.equal(
    firstSearchResult('extract page text', catalog),
    'browser_text_evidence',
  );
  assert.equal(firstSearchResult('execute code cell', catalog), 'exec');
  assert.equal(firstSearchResult('wait cell output', catalog), 'wait');
});

void test('searchToolCatalog uses BM25 tokenization for camelCase and acronyms', () => {
  const catalog: readonly ToolSearchCatalogCard[] = [
    createCatalogCard({
      publicName: 'readHTTPResponse',
      family: 'network',
      summary: 'Inspect a response body from a URL.',
      searchHints: [],
      tags: ['network'],
      whenToUse: 'Inspect a response body from a URL.',
    }),
    createCatalogCard({
      publicName: 'read_notes',
      family: 'file',
      summary: 'Read a note file.',
      searchHints: [],
      tags: ['file'],
      whenToUse: 'Read a note file.',
    }),
  ];

  assert.equal(firstSearchResult('http response', catalog), 'readHTTPResponse');
});

void test('searchToolCatalog does not fake web_search with fetch_url', () => {
  const catalog = buildToolSearchCatalog(
    readRegisteredTools(createBuiltinToolRegistryStore()),
  );
  const results = searchToolCatalog('web search', catalog);

  assert.equal(
    results.some((result) => result.publicName === 'web_search'),
    false,
  );
  assert.notEqual(results[0]?.publicName, 'fetch_url');
});

void test('tool_search executes against the injected catalog without registry access', async () => {
  const catalog: readonly ToolSearchCatalogCard[] = [
    createCatalogCard({
      publicName: 'read_file',
      family: 'file',
      summary: 'Read a known file.',
      searchHints: ['cat file'],
      tags: ['file'],
      whenToUse: 'Read a known file.',
      notFor: 'Searching unknown paths.',
    }),
  ];
  const tool = createToolSearchTool({ getCatalog: () => catalog });
  const result = await tool.execute(
    { query: 'cat file' },
    createStandaloneContext(),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    ok: true;
    total: number;
    results: Array<{
      publicName: string;
      family?: string;
      registryName?: string;
    }>;
    note: string;
  };
  assert.equal(output.ok, true);
  assert.equal(output.total, 1);
  assert.equal(output.results[0]?.publicName, 'read_file');
  assert.equal(output.results[0]?.family, 'file');
  assert.equal(output.results[0]?.registryName, undefined);
  assert.deepEqual(Object.keys(output.results[0] ?? {}), [
    'rank',
    'score',
    'publicName',
    'family',
    'summary',
    'sideEffectLevel',
    'approvalClass',
    'mayMutateComputerFiles',
    'signatureRef',
  ]);
  assert.match(output.note, /not callable aliases/);
});

void test('tool_search limits discovery to the run-authorized tool surface', async () => {
  const catalog: readonly ToolSearchCatalogCard[] = [
    createCatalogCard({
      publicName: 'read_file',
      family: 'file',
      summary: 'Read a known file.',
      searchHints: ['cat file'],
      tags: ['file'],
      whenToUse: 'Read a known file.',
    }),
    createCatalogCard({
      publicName: 'write_file',
      family: 'file',
      summary: 'Write a file.',
      searchHints: ['write file'],
      tags: ['file'],
      whenToUse: 'Write a file.',
    }),
  ];
  const tool = createToolSearchTool({ getCatalog: () => catalog });
  const result = await tool.execute(
    { query: 'file' },
    createStandaloneContext(['read_file', 'tool_search']),
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as {
    ok: true;
    total: number;
    results: Array<{ publicName: string }>;
  };
  assert.equal(output.total, 1);
  assert.deepEqual(
    output.results.map((entry) => entry.publicName),
    ['read_file'],
  );
});

void test('restricted BM25 discovery and generated SDK projection share run authorization', async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-search-'));
  t.after(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const registry = createBuiltinToolRegistryStore();
  const allowedRegistryNames = [
    'tool_search',
    'read_file',
    'fetch_url',
    'write_file',
  ];
  const projectionPort = createToolLibraryProjectionPort({
    registry,
    runtimeRootForState: () => runtimeRoot,
    sdkVersion: 'sdk-v1',
    sourceRegistryVersion: 'registry-v1',
    runtimeCompatibilityRange: 'runtime-v1',
    modelFacingCatalogRef: 'geulbat-sdk://catalog',
    importSpecifier: 'geulbat-sdk',
    projectionPolicy: { policyId: 'ptc-reachable-test' },
  });
  const projectionResult = await projectionPort.resolveProjection({
    stateRoot: '/home-state',
    threadId: 'thread-tool-search-parity',
    allowedRegistryNames,
  });
  assert.equal(projectionResult.ok, true);
  if (!projectionResult.ok) {
    return;
  }
  assert.deepEqual(projectionResult.projection.allowedRegistryNames, [
    'fetch_url',
    'read_file',
  ]);

  const tool = createToolSearchTool({
    getCatalog: () => buildToolSearchCatalog(readRegisteredTools(registry)),
  });
  const search = async (query: string) => {
    const result = await tool.execute(
      { query },
      createStandaloneContext(allowedRegistryNames),
    );
    assert.equal(result.ok, true);
    return JSON.parse(result.output) as {
      results: Array<{ publicName: string }>;
    };
  };

  assert.equal((await search('open url')).results[0]?.publicName, 'fetch_url');
  assert.equal((await search('read file')).results[0]?.publicName, 'read_file');
  assert.equal(
    (await search('grep text')).results.some(
      (entry) => entry.publicName === 'search_files',
    ),
    false,
  );
  assert.equal(
    (await search('write file')).results[0]?.publicName,
    'write_file',
  );
  assert.equal(
    projectionResult.projection.allowedRegistryNames.includes('write_file'),
    false,
  );
});

function createCatalogCard(
  overrides: Pick<
    ToolSearchCatalogCard,
    'publicName' | 'family' | 'summary' | 'searchHints' | 'tags' | 'whenToUse'
  > &
    Partial<ToolSearchCatalogCard>,
): ToolSearchCatalogCard {
  return {
    sideEffectLevel: 'read',
    approvalClass: 'approval_free',
    mayMutateComputerFiles: false,
    signatureRef: buildToolSignatureRef(overrides.publicName),
    notFor: 'Other tool actions.',
    ...overrides,
  };
}

function firstSearchResult(
  query: string,
  catalog: readonly ToolSearchCatalogCard[],
): string | undefined {
  return searchToolCatalog(query, catalog)[0]?.publicName;
}

function readRegisteredTools(
  registry: ReturnType<typeof createBuiltinToolRegistryStore>,
): AnyTool[] {
  return registry
    .getAllRegisteredToolNames()
    .map((name) => registry.getTool(name))
    .filter((tool): tool is AnyTool => tool !== undefined);
}

function createStandaloneContext(
  allowedRegistryNames?: readonly string[],
): ToolExecutionContext {
  return {
    callId: 'tool-search-test',
    ...(allowedRegistryNames === undefined ? {} : { allowedRegistryNames }),
  };
}
