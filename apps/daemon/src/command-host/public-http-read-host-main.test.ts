import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import test from 'node:test';

import { guardedLookupPublicAddress } from './public-http-address-guard.js';
import { PUBLIC_HTTP_READ_PROTOCOL_VERSION } from './public-http-read-protocol.js';
import { runPublicHttpReadHost } from './public-http-read-host-main.js';

void test('public HTTP read host pins DNS and returns the complete body', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.accept, 'text/plain');
    response.writeHead(200, {
      'content-length': '7',
      'content-type': 'text/plain',
      location: '/next',
    });
    response.end('payload');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await runPublicHttpReadHost(
    JSON.stringify({
      version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
      url: `http://public.example:${address.port}/resource`,
      method: 'GET',
      headers: { accept: 'text/plain' },
      responseBodyMode: 'full',
    }),
    {
      lookupPublicAddress: async (hostname) => {
        assert.equal(hostname, 'public.example');
        return { address: '127.0.0.1', family: 4 };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.location, '/next');
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.contentLength, 7);
  assert.equal(Buffer.from(result.bodyBase64, 'base64').toString(), 'payload');
});

void test('public HTTP read host discards GET bodies for metadata probes', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-length': '10000000',
      'content-type': 'application/javascript',
    });
    response.write(Buffer.alloc(64 * 1024));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await runPublicHttpReadHost(
    JSON.stringify({
      version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
      url: `http://cdn.example:${address.port}/large.js`,
      method: 'GET',
      headers: { accept: '*/*' },
      responseBodyMode: 'discard',
    }),
    {
      lookupPublicAddress: async () => ({
        address: '127.0.0.1',
        family: 4,
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.contentLength, 10_000_000);
  assert.equal(result.bodyBase64, '');
});

void test('public HTTP read host stops a body that exceeds the caller policy', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(Buffer.alloc(32));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await runPublicHttpReadHost(
    JSON.stringify({
      version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
      url: `http://media.example:${address.port}/video`,
      method: 'GET',
      headers: { accept: 'video/*' },
      responseBodyMode: 'full',
      maxResponseBytes: 16,
    }),
    {
      lookupPublicAddress: async () => ({
        address: '127.0.0.1',
        family: 4,
      }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected response size rejection');
  }
  assert.equal(result.reasonCode, 'response_too_large');
});

void test('public HTTP read host rejects private DNS targets before connecting', async () => {
  const result = await runPublicHttpReadHost(
    JSON.stringify({
      version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
      url: 'http://public.example/private',
      method: 'GET',
      headers: {},
      responseBodyMode: 'full',
    }),
    {
      lookupPublicAddress: (hostname) =>
        guardedLookupPublicAddress(hostname, {
          label: 'public HTTP read URL',
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected private address rejection');
  }
  assert.equal(result.reasonCode, 'dns_blocked');
  assert.match(result.message, /unsafe network address/u);
});

void test('public HTTP read host rejects malformed descriptors', async () => {
  const result = await runPublicHttpReadHost(
    JSON.stringify({
      version: PUBLIC_HTTP_READ_PROTOCOL_VERSION,
      url: 'https://example.com/',
      method: 'DELETE',
      headers: {},
      responseBodyMode: 'full',
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected invalid request');
  }
  assert.equal(result.reasonCode, 'invalid_request');
});
