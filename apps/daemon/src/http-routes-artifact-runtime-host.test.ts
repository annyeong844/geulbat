import test from 'node:test';
import assert from 'node:assert/strict';

import { withDaemonServer } from './test-support/http-routes.js';

void test('artifact runtime host route is public and embeddable from the shell that the daemon serves', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/host?parentOrigin=${encodeURIComponent(`http://127.0.0.1:${port}`)}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), null);
    // 이 호스트를 감싸는 것은 데몬이 서빙한 shell 화면이다. loopback
    // 와일드카드는 같은 기계의 아무 페이지에나 액자를 허용했다.
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'self'(;|$)/m,
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
    assert.match(body, new RegExp(`"http://127\\.0\\.0\\.1:${port}"`));
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

void test('artifact runtime host drops parentOrigin values from other local pages', async () => {
  // 부모라고 주장할 수 있는 곳은 데몬이 서빙한 shell뿐이다. 이 값이 통과하면
  // 런타임이 다른 로컬 페이지로 postMessage를 보내게 된다.
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/artifact-runtime/host?parentOrigin=${encodeURIComponent('http://127.0.0.1:1')}`,
    );

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /const parentOrigin = null;/);
    assert.doesNotMatch(body, /http:\/\/127\.0\.0\.1:1"/);
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

void test('artifact runtime host does not expose obsolete same-origin probe routes', async () => {
  await withDaemonServer(async ({ port }) => {
    for (const path of [
      '/artifact-runtime/probe-sw.js',
      '/artifact-runtime/probe-cache.txt',
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});
