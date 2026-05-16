import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebFetchTool } from './web-fetch.js';

void test('web_fetch exposes scalar URL schema and read-only metadata', () => {
  const tool = createWebFetchTool({
    fetchWebUrl: async () => ({
      ok: true,
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      status: 200,
      contentType: 'text/plain',
      content: 'ok',
      truncated: false,
      untrusted: true,
    }),
  });

  assert.equal(tool.name, 'web_fetch');
  assert.equal(tool.sideEffectLevel, 'read');
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.mayMutateWorkspaceFiles, false);
  assert.equal(tool.parallelBatchKind, undefined);
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.ok('url' in tool.parameters.properties);
  assert.ok(!('urls' in tool.parameters.properties));
  assert.ok(!('maxUrls' in tool.parameters.properties));
});

void test('web_fetch forwards extractMode to the runtime owner', async () => {
  let seenExtractMode: string | undefined;
  const tool = createWebFetchTool({
    fetchWebUrl: async (args) => {
      seenExtractMode = args.extractMode;
      return {
        ok: true,
        url: args.url,
        finalUrl: args.url,
        status: 200,
        contentType: 'text/plain',
        content: 'ok',
        truncated: false,
        untrusted: true,
      };
    },
  });

  const result = await tool.execute(
    { url: 'https://example.com/', extractMode: 'markdown' },
    { callId: 'call-web-fetch', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, true);
  assert.equal(seenExtractMode, 'markdown');
});

void test('web_fetch returns tool-level failure while preserving structured fetch failure output', async () => {
  const tool = createWebFetchTool({
    fetchWebUrl: async (args) => ({
      ok: false,
      url: args.url,
      reasonCode: 'unsafe_url',
      message: 'web_fetch URL resolves to a blocked hostname.',
      untrusted: true,
    }),
  });

  const result = await tool.execute(
    { url: 'https://example.com/' },
    { callId: 'call-web-fetch', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'web_fetch URL resolves to a blocked hostname.');
  assert.deepEqual(JSON.parse(result.output), {
    ok: false,
    url: 'https://example.com/',
    reasonCode: 'unsafe_url',
    message: 'web_fetch URL resolves to a blocked hostname.',
    untrusted: true,
  });
});

void test('web_fetch rejects maxChars outside the owner budget during argument parsing', async () => {
  const tool = createWebFetchTool();
  const result = await tool.execute(
    { url: 'https://example.com/', maxChars: 0 },
    { callId: 'call-web-fetch', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /maxChars/);
});
