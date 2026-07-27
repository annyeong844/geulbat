import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHELL_ACCESS_TOKEN_META_NAME } from '@geulbat/protocol/shell-auth';

import { writeThreadMediaFile } from './daemon/sessions/media-file-store.js';
import {
  withAuthenticatedDaemonServer,
  withDaemonServer,
} from './test-support/http-routes.js';

const MEDIA_THREAD_ID = '11111111-1111-4111-8111-111111111111';

/**
 * 데몬이 web-shell 산출물을 같은 origin에서 서빙하면 dev proxy 없이 포트가
 * 하나로 합쳐진다. 여기서 잠그는 것은 두 가지다: 정적 자산이 인증 없이
 * 열리는가, 그리고 그 서빙이 `/api`의 인증·오류 계약을 삼키지 않는가.
 *
 * 두 번째가 더 중요하다. SPA fallback이 `/api`까지 `index.html`로 되돌리면
 * 인증 실패와 존재하지 않는 라우트가 조용히 200 HTML로 바뀐다.
 */
async function createShellAssetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-shell-assets-'));
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><title>geulbat</title><div id="root"></div>',
    'utf8',
  );
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(
    join(root, 'assets', 'app.js'),
    'export const shellEntry = true;\n',
    'utf8',
  );
  await writeFile(join(root, 'favicon.svg'), '<svg />', 'utf8');
  return root;
}

void test('daemon serves the shell entry document without authentication', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await res.text(), /<div id="root"><\/div>/);
    },
    { shellAssetRoot },
  );
});

void test('daemon serves shell bundle assets without authentication', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);

      assert.equal(res.status, 200);
      assert.match(await res.text(), /shellEntry/);
    },
    { shellAssetRoot },
  );
});

void test('shell asset serving returns the entry document for client routes', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/threads/some-thread`);

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await res.text(), /<div id="root"><\/div>/);
    },
    { shellAssetRoot },
  );
});

void test('shell asset serving does not swallow unauthenticated api requests', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/threads`);

      assert.equal(res.status, 401);
      assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/);
    },
    { shellAssetRoot },
  );
});

void test('shell asset serving does not turn an unknown api route into the shell document', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/definitely-not-a-route`,
      );

      assert.notEqual(res.status, 200);
      assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/);
    },
    { shellAssetRoot },
  );
});

void test('hashed bundle assets are cacheable so a revisit does not refetch them', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);

      assert.equal(res.status, 200);
      // 파일명에 content hash가 있으므로 같은 이름의 내용은 바뀌지 않는다.
      // 전역 no-store가 여기까지 적용되면 재방문마다 번들 전체를 다시 받는다.
      const cacheControl = res.headers.get('cache-control') ?? '';
      assert.match(cacheControl, /immutable/);
      assert.doesNotMatch(cacheControl, /no-store/);
    },
    { shellAssetRoot },
  );
});

void test('the entry document revalidates instead of being stored or pinned', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);

      assert.equal(res.status, 200);
      // index.html은 파일명이 고정이므로 오래 붙잡으면 새 빌드가 도달하지
      // 않는다. 보관은 허용하고 매번 확인시킨다.
      const cacheControl = res.headers.get('cache-control') ?? '';
      assert.match(cacheControl, /no-cache/);
      assert.doesNotMatch(cacheControl, /immutable/);
    },
    { shellAssetRoot },
  );
});

void test('unhashed root assets revalidate rather than being pinned for a year', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/favicon.svg`);

      assert.equal(res.status, 200);
      // `assets/` 밖의 파일은 빌드가 그대로 복사하므로 content hash가 없다.
      assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/);
    },
    { shellAssetRoot },
  );
});

void test('api responses keep the no-store policy', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/threads`);

      assert.equal(res.status, 401);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    },
    { shellAssetRoot },
  );
});

void test('a missing bundle asset is not answered with the shell document', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);

      // SPA fallback이 여기까지 오면 브라우저가 HTML을 JS로 파싱하려다
      // 엉뚱한 구문 오류를 낸다. 없는 자산은 없다고 답한다.
      assert.equal(res.status, 404);
      assert.doesNotMatch(await res.text(), /<div id="root"><\/div>/);
    },
    { shellAssetRoot },
  );
});

void test('a dotted client route still reaches the shell document', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/threads/v2.0`);

      // 정적 확장자 차단이 점 있는 client route까지 삼켜서는 안 된다.
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<div id="root"><\/div>/);
    },
    { shellAssetRoot },
  );
});

void test('the served entry document carries the shell access token', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();

      // 토큰은 사용자가 입력하지 않는다. 데몬이 자기가 서빙하는 문서에 싣는다.
      assert.match(
        body,
        new RegExp(`<meta name="${SHELL_ACCESS_TOKEN_META_NAME}" content="`),
      );
    },
    { shellAssetRoot },
  );
});

void test('the entry cookie authorizes browser-native media range requests', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port, daemonContext }) => {
      const entryResponse = await fetch(`http://127.0.0.1:${port}/`);
      const setCookie = entryResponse.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /^geulbat_dev_auth=/);
      assert.match(setCookie, /;\s*HttpOnly(?:;|$)/);
      assert.match(setCookie, /;\s*Path=\/(?:;|$)/);
      assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/);
      assert.doesNotMatch(setCookie, /;\s*Max-Age=/);

      const cookie = setCookie.split(';', 1)[0];
      assert.ok(cookie);

      const bytes = new TextEncoder().encode('0123456789abcdef');
      const written = await writeThreadMediaFile({
        workspaceRoot: daemonContext.homeStateRoot,
        threadId: MEDIA_THREAD_ID,
        extension: 'mp4',
        bytes,
        maxBytes: 1024,
      });
      const mediaResponse = await fetch(
        `http://127.0.0.1:${port}/api/threads/${MEDIA_THREAD_ID}/media/${written.mediaRef}`,
        {
          headers: {
            Cookie: cookie,
            Range: 'bytes=4-7',
          },
        },
      );

      assert.equal(mediaResponse.status, 206);
      assert.equal(
        mediaResponse.headers.get('content-range'),
        `bytes 4-7/${bytes.length}`,
      );
      assert.equal(await mediaResponse.text(), '4567');
    },
    { shellAssetRoot },
  );
});

void test('the token-bearing document is not readable from another origin', async () => {
  const shellAssetRoot = await createShellAssetRoot();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Origin: 'http://localhost:8080' },
      });

      // 같은 머신의 다른 로컬 서버가 띄운 페이지가 이 문서를 읽으면 토큰을
      // 가져간다. 정적 자산에는 CORS 허용 헤더를 주지 않는다.
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    },
    { shellAssetRoot },
  );
});

void test('daemon runs without shell assets so the dev proxy path is unchanged', async () => {
  await withDaemonServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);

    // Express 기본 404 본문도 HTML이므로 content-type으로는 구별할 수 없다.
    // 잠글 것은 "shell 문서가 서빙되지 않는다"이다.
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /<div id="root"><\/div>/);
  });
});
