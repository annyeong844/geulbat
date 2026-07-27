import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexDirectPromptCacheProjection,
  buildCodexDirectWireTools,
  buildResponsesRequestBody,
  buildResponsesRequestHeaders,
} from './codex-request.js';
import { resolveProviderRequestOptions } from './provider-options.js';
import type { WireToolDefinition } from './wire/types.js';

const readFileTool: WireToolDefinition = {
  type: 'function',
  name: 'read_file',
  description: 'Read a file.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
};

const externalTool: WireToolDefinition = {
  type: 'function',
  name: 'mcp_external_lookup',
  description: 'Look up an external record.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  strict: false,
};

void test('buildResponsesRequestHeaders uses the current Codex direct originator', () => {
  const headers = buildResponsesRequestHeaders({
    accessToken: 'token',
    accountId: 'account',
    providerSessionId: 'provider-session',
  });

  assert.equal(headers.get('originator'), 'codex_cli_rs');
});

void test('Codex request assembly preserves direct tools and appends the deferred hosted-search surface', () => {
  const input = {
    systemPrompt: 'Use the available tools.',
    tools: [readFileTool],
    deferredTools: [externalTool],
    providerSessionId: 'provider-session',
    providerRequestOptions: resolveProviderRequestOptions({}),
  };
  const expectedTools = [
    readFileTool,
    { ...externalTool, defer_loading: true },
    { type: 'tool_search' },
  ];

  assert.deepEqual(buildCodexDirectWireTools(input), expectedTools);
  const cacheProjection = buildCodexDirectPromptCacheProjection(input);
  const body = buildResponsesRequestBody(input, cacheProjection);
  assert.deepEqual(body.tools, expectedTools);
  assert.equal(body.tool_choice, 'auto');
});

void test('Codex request assembly does not add hosted search without deferred tools', () => {
  assert.deepEqual(
    buildCodexDirectWireTools({
      tools: [readFileTool],
    }),
    [readFileTool],
  );
});
