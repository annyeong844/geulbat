import test from 'node:test';
import assert from 'node:assert/strict';
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import {
  PUBLIC_WEB_DOM_COUNTER_PATH,
  PUBLIC_WEB_EVENTSOURCE_ECHO_PATH,
  PUBLIC_WEB_JSON_ECHO_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH,
  PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH,
  PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
} from '@geulbat/protocol/public-web-fixtures';

import { withPublicWebConformanceServer } from './test-support/http-routes.js';

void test('public react bundle fixture entry route is unauthenticated and same-origin readable', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );
    assert.equal(
      res.headers.get('content-type'),
      'application/javascript; charset=utf-8',
    );

    const body = await res.text();
    assert.match(
      body,
      /import \{ mountCounterApp \} from '\.\/counter-app\.js';/,
    );
    assert.match(body, /export default/);
    assert.match(body, /mount\(args\)/);
  });
});

void test('public react bundle fixture chunk route exposes the multi-chunk counter app', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_REACT_BUNDLE_COUNTER_CHUNK_PATH}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );

    const body = await res.text();
    assert.match(body, /export function mountCounterApp/);
    assert.match(body, /React\.useState\(0\)/);
    assert.match(body, /storage\?\.set\?\./);
    assert.match(body, /count:\$\{count\}/);
  });
});

void test('public react hello-card bundle fixture entry route is unauthenticated and script-loadable', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_ENTRY_PATH}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );

    const body = await res.text();
    assert.match(
      body,
      /import \{ mountHelloCardApp \} from '\.\/hello-card-app\.js';/,
    );
    assert.match(body, /export default/);
    assert.match(body, /mount\(args\)/);
  });
});

void test('public react hello-card bundle fixture chunk route exposes a runnable hello-card app', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_REACT_BUNDLE_HELLO_CARD_CHUNK_PATH}`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );

    const body = await res.text();
    assert.match(body, /export function mountHelloCardApp/);
    assert.match(body, /React\.useState\(0\)/);
    assert.match(body, /publicWebFixture\.reactHelloCard/);
    assert.match(body, /안녕하세요 ;ㅅ;/);
    assert.match(body, /클릭 수: \$\{count\}/);
  });
});

void test('public react runtime-dependencies bundle fixtures expose entry, module, and stylesheet assets', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const baseUrl = `http://127.0.0.1:${port}`;

    const entryRes = await fetch(
      `${baseUrl}${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH}`,
    );
    assert.equal(entryRes.status, 200);
    assert.equal(
      entryRes.headers.get('content-type'),
      'application/javascript; charset=utf-8',
    );
    assert.equal(
      entryRes.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );
    assert.match(
      await entryRes.text(),
      /from 'geulbat-runtime-dependency-fixture'/,
    );

    const moduleRes = await fetch(
      `${baseUrl}${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_MODULE_PATH}`,
    );
    assert.equal(moduleRes.status, 200);
    assert.equal(
      moduleRes.headers.get('content-type'),
      'application/javascript; charset=utf-8',
    );
    assert.match(await moduleRes.text(), /runtime dependency loaded/);

    const stylesheetRes = await fetch(
      `${baseUrl}${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_STYLESHEET_PATH}`,
    );
    assert.equal(stylesheetRes.status, 200);
    assert.equal(
      stylesheetRes.headers.get('content-type'),
      'text/css; charset=utf-8',
    );
    assert.match(await stylesheetRes.text(), /\.runtime-dependency-card/);
  });
});

void test('public dom counter fixture route is unauthenticated and script-loadable', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_DOM_COUNTER_PATH}`,
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'application/javascript; charset=utf-8',
    );

    const body = await res.text();
    assert.match(body, /document\.getElementById\('btn'\)/);
    assert.match(body, /addEventListener\('click'/);
    assert.match(body, /value\.textContent = String\(count\)/);
  });
});

void test('public json echo fixture route is unauthenticated and same-origin readable', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_JSON_ECHO_PATH}?message=hello`,
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'application/json; charset=utf-8',
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );

    assert.deepEqual(await res.json(), {
      message: 'hello',
      method: 'GET',
      path: PUBLIC_WEB_JSON_ECHO_PATH,
    });
  });
});

void test('public eventsource echo fixture route is unauthenticated and same-origin readable', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await fetch(
      `http://127.0.0.1:${port}${PUBLIC_WEB_EVENTSOURCE_ECHO_PATH}?message=stream`,
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'text/event-stream; charset=utf-8',
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
    );

    assert.equal(await res.text(), 'data: stream\n\n');
  });
});

void test('public request identity echo fixture route exposes request identity fields', async () => {
  await withPublicWebConformanceServer(async ({ port }) => {
    const res = await requestTextFixture({
      port,
      path: PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
      headers: {
        authorization: 'Bearer host-token',
        cookie: 'geulbat_identity_probe=host-cookie',
        referer: 'http://127.0.0.1/internal',
        'x-geulbat-dev-token': 'host-dev-token',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers['content-type'],
      'application/json; charset=utf-8',
    );
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');

    assert.deepEqual(JSON.parse(res.body), {
      method: 'GET',
      path: PUBLIC_WEB_REQUEST_IDENTITY_ECHO_PATH,
      cookie: 'geulbat_identity_probe=host-cookie',
      authorization: 'Bearer host-token',
      devToken: 'host-dev-token',
      referrer: 'http://127.0.0.1/internal',
    });
  });
});

async function requestTextFixture(args: {
  port: number;
  path: string;
  headers: Record<string, string>;
}): Promise<{
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const req = requestHttp(
      {
        hostname: '127.0.0.1',
        port: args.port,
        path: args.path,
        method: 'GET',
        headers: args.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
