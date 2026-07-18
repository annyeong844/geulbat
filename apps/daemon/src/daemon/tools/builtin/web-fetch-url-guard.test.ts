import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guardedLookupPublicAddress,
  isUnsafeWebFetchAddress,
  parseWebFetchHttpUrl,
} from './web-fetch-url-guard.js';

void test('parseWebFetchHttpUrl accepts http and https URLs', () => {
  assert.equal(parseWebFetchHttpUrl('https://example.com/path').ok, true);
  assert.equal(parseWebFetchHttpUrl('http://example.com/path').ok, true);
});

void test('parseWebFetchHttpUrl rejects unsupported schemes and embedded credentials', () => {
  assert.deepEqual(parseWebFetchHttpUrl('file:///etc/passwd'), {
    ok: false,
    reasonCode: 'invalid_url',
    message: 'fetch_url only supports http and https URLs.',
  });
  assert.deepEqual(parseWebFetchHttpUrl('https://user:pass@example.com/'), {
    ok: false,
    reasonCode: 'unsafe_url',
    message: 'fetch_url URL must not include embedded credentials.',
  });
});

void test('parseWebFetchHttpUrl rejects localhost before network fetch', () => {
  assert.deepEqual(parseWebFetchHttpUrl('http://localhost:5173/'), {
    ok: false,
    reasonCode: 'unsafe_url',
    message: 'fetch_url URL resolves to a blocked hostname.',
  });
});

void test('parseWebFetchHttpUrl rejects bracketed unsafe IPv6 literals', () => {
  for (const url of [
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[2001:db8::1]/',
  ]) {
    const result = parseWebFetchHttpUrl(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) {
      assert.equal(result.reasonCode, 'unsafe_url');
    }
  }
});

void test('isUnsafeWebFetchAddress rejects loopback, private, link-local, multicast, and documentation ranges', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.10',
    '169.254.1.1',
    '224.0.0.1',
    '192.0.2.10',
    '198.51.100.10',
    '203.0.113.10',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ]) {
    assert.equal(isUnsafeWebFetchAddress(address), true, address);
  }

  assert.equal(isUnsafeWebFetchAddress('93.184.216.34'), false);
  assert.equal(
    isUnsafeWebFetchAddress('2606:2800:220:1:248:1893:25c8:1946'),
    false,
  );
});

void test('guardedLookupPublicAddress rejects unsafe resolved addresses before connect', async () => {
  await assert.rejects(
    () =>
      guardedLookupPublicAddress('example.test', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    /unsafe network address/,
  );
});

void test('guardedLookupPublicAddress returns a public address from injected DNS lookup', async () => {
  const result = await guardedLookupPublicAddress('example.test', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  assert.deepEqual(result, { address: '93.184.216.34', family: 4 });
});
