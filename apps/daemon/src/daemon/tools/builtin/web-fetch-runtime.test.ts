import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWebUrl, requestWebFetchUrl } from './web-fetch-runtime.js';

void test('fetchWebUrl shapes successful text content and labels it untrusted', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
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

void test('fetchWebUrl preserves successful text content without maxChars truncation', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/text',
    extractMode: 'text',
    requestWebFetchUrl: async () => ({
      status: 200,
      location: null,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('abcdef'),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, 'abcdef');
  assert.ok(!('truncated' in result));
  assert.ok(!('truncationReason' in result));
});

void test('fetchWebUrl treats non-2xx text responses as fetched responses with status', async () => {
  const result = await fetchWebUrl({
    url: 'https://example.com/missing',
    extractMode: 'text',
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

void test('fetchWebUrl preserves large injected text content for output offload', async () => {
  const content = 'x'.repeat(3 * 1024 * 1024);
  const result = await fetchWebUrl({
    url: 'https://example.com/large',
    extractMode: 'text',
    requestWebFetchUrl: async () => ({
      status: 200,
      location: null,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from(content),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.content.length, content.length);
  assert.equal(result.content, content);
});

void test('fetchWebUrl rejects redirect loops without a numeric redirect budget', async () => {
  const fetchedUrls: string[] = [];
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    requestWebFetchUrl: async (url) => {
      fetchedUrls.push(url.href);
      return {
        status: 302,
        location:
          url.pathname === '/'
            ? 'https://example.com/next'
            : 'https://example.com/',
        contentType: null,
        body: Buffer.alloc(0),
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'redirect_loop_detected');
  assert.deepEqual(fetchedUrls, [
    'https://example.com/',
    'https://example.com/next',
  ]);
});

void test('fetchWebUrl does not pass hidden timeout policy to the transport', async () => {
  let timeoutFieldWasPresent = true;
  const result = await fetchWebUrl({
    url: 'https://example.com/',
    extractMode: 'text',
    requestWebFetchUrl: async (_url, options) => {
      timeoutFieldWasPresent = 'timeoutMs' in options;
      return {
        status: 200,
        location: null,
        contentType: 'text/plain; charset=utf-8',
        body: Buffer.from('ok'),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(timeoutFieldWasPresent, false);
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
