import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guardedLookupPublicAddress,
  isUnsafeHttpAddress,
  isUnsafeHttpHostname,
  parseHttpUrl,
} from './http-url-guard.js';

void test('parseHttpUrl accepts absolute http and https URLs', () => {
  assert.equal(parseHttpUrl('https://esm.sh/react@18.2.0').ok, true);
  assert.equal(parseHttpUrl('http://cdn.example.com/app.js').ok, true);
});

void test('parseHttpUrl rejects unsupported schemes and embedded credentials', () => {
  for (const url of [
    'data:text/javascript,alert(1)',
    'javascript:alert(1)',
    'ftp://example.com/pkg.js',
    'https://user:pass@example.com/pkg.js',
  ]) {
    const result = parseHttpUrl(url, { label: 'dependency probe' });
    assert.equal(result.ok, false, url);
  }
});

void test('parseHttpUrl rejects local and private URL literals', () => {
  for (const url of [
    'http://localhost/pkg.js',
    'http://127.0.0.1/pkg.js',
    'http://10.0.0.5/pkg.js',
    'http://192.168.1.2/pkg.js',
    'http://172.16.0.2/pkg.js',
    'http://[::1]/pkg.js',
    'http://[fc00::1]/pkg.js',
    'http://[fe80::1]/pkg.js',
    'http://[2001:db8::1]/pkg.js',
    'http://[::ffff:127.0.0.1]/pkg.js',
    'http://[::ffff:10.0.0.1]/pkg.js',
    'http://[::ffff:7f00:1]/pkg.js',
    'http://[::ffff:a00:1]/pkg.js',
  ]) {
    const result = parseHttpUrl(url, { label: 'dependency probe' });
    assert.equal(result.ok, false, url);
  }
});

void test('isUnsafeHttpAddress rejects IPv4-mapped private IPv6 addresses', () => {
  assert.equal(isUnsafeHttpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:10.0.0.1'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:192.168.1.1'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:93.184.216.34'), false);
  assert.equal(isUnsafeHttpAddress('::ffff:7f00:1'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:a00:1'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:c0a8:101'), true);
  assert.equal(isUnsafeHttpAddress('::ffff:5db8:d822'), false);
});

void test('isUnsafeHttpHostname rejects localhost-style hostnames', () => {
  assert.equal(isUnsafeHttpHostname('localhost'), true);
  assert.equal(isUnsafeHttpHostname('api.localhost'), true);
  assert.equal(isUnsafeHttpHostname('esm.sh'), false);
});

void test('guardedLookupPublicAddress rejects any unsafe resolved address', async () => {
  await assert.rejects(
    () =>
      guardedLookupPublicAddress('esm.sh', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
    /unsafe network address resolved/,
  );
});
