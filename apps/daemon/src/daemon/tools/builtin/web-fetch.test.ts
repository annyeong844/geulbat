import test from 'node:test';
import assert from 'node:assert/strict';

import { isToolObjectParameters } from '../types.js';
import { createFetchUrlTool } from './web-fetch.js';

void test('fetch_url exposes scalar URL schema and read-only metadata', () => {
  const tool = createFetchUrlTool({
    fetchWebUrl: async () => ({
      ok: true,
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      status: 200,
      contentType: 'text/plain',
      content: 'ok',
      untrusted: true,
    }),
  });

  assert.equal(tool.name, 'fetch_url');
  assert.equal(tool.sideEffectLevel, 'read');
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.mayMutateComputerFiles, false);
  assert.equal(tool.recoveryStrategy, 'replay_safe');
  assert.equal(tool.parallelBatchKind, undefined);
  const parameters = tool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['url']);
  assert.ok('url' in parameters.properties);
  assert.ok(!('urls' in parameters.properties));
  assert.ok(!('maxUrls' in parameters.properties));
  assert.ok(!('maxChars' in parameters.properties));
});

void test('fetch_url forwards extractMode to the runtime owner', async () => {
  let seenExtractMode: string | undefined;
  const tool = createFetchUrlTool({
    fetchWebUrl: async (args) => {
      seenExtractMode = args.extractMode;
      return {
        ok: true,
        url: args.url,
        finalUrl: args.url,
        status: 200,
        contentType: 'text/plain',
        content: 'ok',
        untrusted: true,
      };
    },
  });

  const result = await tool.execute(
    { url: 'https://example.com/', extractMode: 'markdown' },
    { callId: 'call-web-fetch' },
  );

  assert.equal(result.ok, true);
  assert.equal(seenExtractMode, 'markdown');
});

void test('fetch_url returns tool-level failure while preserving structured fetch failure output', async () => {
  const tool = createFetchUrlTool({
    fetchWebUrl: async (args) => ({
      ok: false,
      url: args.url,
      reasonCode: 'unsafe_url',
      message: 'fetch_url URL resolves to a blocked hostname.',
      untrusted: true,
    }),
  });

  const result = await tool.execute(
    { url: 'https://example.com/' },
    { callId: 'call-web-fetch' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'fetch_url URL resolves to a blocked hostname.');
  assert.deepEqual(JSON.parse(result.output), {
    ok: false,
    url: 'https://example.com/',
    reasonCode: 'unsafe_url',
    message: 'fetch_url URL resolves to a blocked hostname.',
    untrusted: true,
  });
});

void test('fetch_url rejects maxChars instead of keeping a truncation control', async () => {
  const tool = createFetchUrlTool();
  const result = await tool.execute(
    { url: 'https://example.com/', maxChars: 3 },
    { callId: 'call-web-fetch' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /unexpected keys: maxChars/u);
});
