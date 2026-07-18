import test from 'node:test';
import assert from 'node:assert/strict';

import { withDaemonServer } from './test-support/http-routes.js';

void test('artifact runtime host route is public and embeddable from loopback web-shell origins', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/host?parentOrigin=${encodeURIComponent('http://127.0.0.1:5173')}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /script-src 'unsafe-inline' 'unsafe-eval' blob: data: http: https:/,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /connect-src blob: data: http: https: ws: wss:/,
    );
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /base-uri 'none'; object-src 'none'/,
    );

    const body = await res.text();
    assert.match(body, /geulbat\.artifact_runtime_host/);
    assert.match(body, /window\.parent\.postMessage/);
    assert.match(body, /new DOMParser\(\)/);
    assert.match(body, /replaceDocumentWithHtml\(data\.documentHtml\)/);
    assert.doesNotMatch(body, /document\.write\(data\.documentHtml\)/);
    assert.match(body, /"http:\/\/127\.0\.0\.1:5173"/);
    assert.doesNotMatch(body, /postMessage\([^)]*['"]\*['"]\)/);
    assert.doesNotMatch(
      body,
      /window\.addEventListener\(\s*'message'[\s\S]*\{\s*once:\s*true\s*\}/,
    );
  });
});

void test('artifact runtime host drops untrusted parentOrigin query values', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/host?parentOrigin=${encodeURIComponent('https://evil.example')}`,
    );

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /const parentOrigin = null;/);
    assert.doesNotMatch(body, /https:\/\/evil\.example/);
  });
});

void test('artifact runtime host frame ancestors include configured external browser origins', async () => {
  const previous = process.env['GEULBAT_ALLOWED_ORIGINS'];
  process.env['GEULBAT_ALLOWED_ORIGINS'] = 'https://demo.trycloudflare.com';

  try {
    await withDaemonServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/artifact-runtime/host`);

      assert.equal(res.status, 200);
      assert.match(
        res.headers.get('content-security-policy') ?? '',
        /https:\/\/demo\.trycloudflare\.com/,
      );
      const body = await res.text();
      assert.match(body, /const parentOrigin = null;/);

      const configuredParentRes = await fetch(
        `http://127.0.0.1:${port}/artifact-runtime/host?parentOrigin=${encodeURIComponent('https://demo.trycloudflare.com')}`,
      );
      const configuredParentBody = await configuredParentRes.text();
      assert.match(
        configuredParentBody,
        /"https:\/\/demo\.trycloudflare\.com"/,
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_ALLOWED_ORIGINS'];
    } else {
      process.env['GEULBAT_ALLOWED_ORIGINS'] = previous;
    }
  }
});

void test('artifact runtime service worker probe is public and same-origin registerable', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/probe-sw.js`,
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('service-worker-allowed'),
      '/artifact-runtime/',
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(
      res.headers.get('content-type'),
      'application/javascript; charset=utf-8',
    );

    const body = await res.text();
    assert.match(body, /self\.skipWaiting\(\)/);
    assert.match(body, /self\.clients\.claim\(\)/);
    assert.match(body, /geulbat\.artifact_runtime_sw_probe/);
  });
});

void test('artifact runtime cache probe is public and same-origin cacheable by the runtime', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/probe-cache.txt`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await res.text(), 'geulbat-artifact-runtime-cache-probe');
  });
});
