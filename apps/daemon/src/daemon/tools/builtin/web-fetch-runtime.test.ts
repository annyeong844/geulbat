import test from 'node:test';
import assert from 'node:assert/strict';

import { WEB_FETCH_TOTAL_TIMEOUT_MS } from './web-fetch-policy.js';
import {
  WebFetchRuntimeError,
  fetchWebUrl,
  requestWebFetchUrl,
} from './web-fetch-runtime.js';

void test('fetchWebUrl shapes successful text content and labels it untrusted', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => ({
      status: 200,
      location: null,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(
        '<html><head><title>Hello</title></head><body>Hello web</body></html>',
      ),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Hello');
  assert.equal(result.untrusted, true);
  assert.match(result.content, /Hello web/);
});

void test('fetchWebUrl rejects redirects to unsafe targets', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => ({
      status: 302,
      location: 'http://127.0.0.1/private',
      contentType: null,
      body: Buffer.alloc(0),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsafe_redirect');
});

void test('fetchWebUrl rejects protocol-relative redirects to unsafe hosts', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => ({
      status: 302,
      location: '//127.0.0.1/private',
      contentType: null,
      body: Buffer.alloc(0),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsafe_redirect');
});

void test('fetchWebUrl fails visibly for unsupported binary content type', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/image.png',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => ({
      status: 200,
      location: null,
      contentType: 'image/png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'unsupported_content_type');
});

void test('fetchWebUrl truncates output by maxChars', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/text',
    extractMode: 'text',
    maxChars: 3,
    requestWebFetchUrl: async () => ({
      status: 200,
      location: null,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('abcdef'),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, 'abc');
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'max_chars');
});

void test('fetchWebUrl treats non-2xx text responses as fetched responses with status', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/missing',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => ({
      status: 404,
      location: null,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('missing page'),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 404);
  assert.equal(result.content, 'missing page');
});

void test('fetchWebUrl preserves classified runtime failures from transport', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/large',
    extractMode: 'text',
    maxChars: 100,
    requestWebFetchUrl: async () => {
      throw new WebFetchRuntimeError(
        'response_too_large',
        'web_fetch response byte budget exceeded',
      );
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'response_too_large');
});

void test('fetchWebUrl reports total timeout across redirects without waiting in real time', async () => {
  let now = 0;
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    maxChars: 100,
    now: () => now,
    requestWebFetchUrl: async () => {
      now += WEB_FETCH_TOTAL_TIMEOUT_MS + 1;
      return {
        status: 302,
        location: 'https://example.com/next',
        contentType: null,
        body: Buffer.alloc(0),
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'timeout');
});

void test('requestWebFetchUrl rejects already-aborted signals before DNS lookup', async () => {
  const controller = new AbortController();
  controller.abort();
  let lookupCalled = false;

  await assert.rejects(
    () =>
      requestWebFetchUrl(new URL('https://example.test/'), {
        signal: controller.signal,
        lookup: async () => {
          lookupCalled = true;
          return [{ address: '93.184.216.34', family: 4 }];
        },
      }),
    /aborted/,
  );

  assert.equal(lookupCalled, false);
});

void test('requestWebFetchUrl applies guarded lookup before connecting', async () => {
  await assert.rejects(
    () =>
      requestWebFetchUrl(new URL('https://example.test/'), {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    /unsafe network address/,
  );
});
