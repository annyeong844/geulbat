import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import express, { Router, type RequestHandler, type Response } from 'express';

import { SHELL_ACCESS_TOKEN_META_NAME } from '@geulbat/protocol/shell-auth';

import { buildShellAuthCookieHeader } from './auth/shell-auth.js';
import { getConfiguredDevToken } from './auth/token.js';

/**
 * 빌드된 web-shell 산출물을 데몬과 같은 origin에서 서빙한다. 화면과 API가 한
 * 포트에 있으므로 shell은 `BASE_URL = ''` 상대 경로를 그대로 쓰고, 브라우저가
 * 붙는 origin은 데몬 자신 하나다.
 *
 * 정적 자산에는 인증을 걸지 않는다. 세 가지 이유가 있다: 번들을 받아야 인증
 * 헤더를 넣는 코드가 실행되므로 인증을 걸면 부트스트랩이 순환하고, 그 순환을
 * URL 토큰으로 피하면 히스토리·로그에 토큰이 남으며, 번들 자체에는 사용자
 * 데이터나 자격증명이 없다. 실제 경계는 그대로다: 모든 데이터 접근과 변경은
 * `requireAuth` 뒤의 `/api`에 남고, 데몬은 기본적으로 loopback에만 바인딩한다.
 *
 * 이 라우터는 `/api`를 절대 처리하지 않는다. SPA fallback이 `/api`를 삼키면
 * 인증 실패와 없는 라우트가 조용히 200 HTML로 바뀐다.
 */

/**
 * 빌드가 content hash를 붙여 내보내는 디렉터리. 이 안의 파일은 이름이 같으면
 * 내용도 같으므로 재검증 없이 재사용할 수 있다. 밖의 파일(`favicon.svg` 등)은
 * 빌드가 그대로 복사하므로 이름이 고정이고 같은 보장을 갖지 않는다.
 */
const HASHED_ASSET_URL_PREFIX = '/assets/';

/**
 * hash된 자산의 보관 기간. content hash가 정체성을 보장하므로 상한을 짧게 둘
 * 이유가 없고, 값 자체는 이 전제에서만 정당하다. 빌드가 hash를 끄면 이 정책이
 * 틀리므로 그 전제는 테스트가 잠근다.
 */
const HASHED_ASSET_MAX_AGE_SECONDS = 31_536_000;

/**
 * 이 확장자로 요청된 경로가 없으면 SPA fallback으로 넘기지 않는다. 없는
 * `.js`에 문서를 돌려주면 브라우저가 HTML을 스크립트로 파싱하려다 원인과
 * 무관한 구문 오류를 낸다. 점이 있는 client route(`/threads/v2.0`)는 이
 * 목록에 없으므로 계속 fallback을 받는다.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.png',
  '.svg',
  '.ttf',
  '.txt',
  '.wasm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
]);

export function createShellAssetRoutes(args: {
  shellAssetRoot: string;
}): Router {
  const router = Router();
  const indexPath = join(args.shellAssetRoot, 'index.html');
  // `index: false` — `/` 도 아래 fallback 한 곳에서 처리해 진입 문서의 소유자를
  // 하나로 둔다.
  const serveStaticFile = express.static(args.shellAssetRoot, {
    index: false,
  });

  const skipApi: RequestHandler = (req, _res, next) => {
    next(isApiPath(req.path) ? 'router' : undefined);
  };

  /**
   * 캐시 정책은 이 라우터가 소유한다. 전역 보안 헤더는 모든 응답에 `no-store`를
   * 두는데, 그것은 대화·파일 내용을 나르는 `/api`에는 옳지만 정적 자산에
   * 적용되면 재방문마다 번들 전체를 다시 받게 만든다.
   */
  const setAssetCachePolicy: RequestHandler = (req, res, next) => {
    res.setHeader(
      'Cache-Control',
      req.path.startsWith(HASHED_ASSET_URL_PREFIX)
        ? `public, max-age=${HASHED_ASSET_MAX_AGE_SECONDS}, immutable`
        : 'no-cache',
    );
    next();
  };

  router.use(skipApi, setAssetCachePolicy, serveStaticFile);

  // client-side route는 서버에 파일이 없다. 진입 문서를 돌려주어 shell이 그
  // 경로를 해석하게 한다. GET/HEAD만 해당한다 — 알 수 없는 경로로 온 mutation을
  // 문서 200으로 바꾸지 않는다.
  router.get(/.*/, skipApi, (req, res, next) => {
    if (STATIC_ASSET_EXTENSIONS.has(extname(req.path).toLowerCase())) {
      next();
      return;
    }
    sendShellEntryDocument(res, indexPath).catch(next);
  });

  return router;
}

/**
 * 진입 문서에 shell 접속 토큰을 싣는다.
 *
 * 사용자가 토큰을 입력하지 않아도 화면이 인증할 수 있어야 원터치 설치가
 * 성립한다. 이 문서는 same-origin에서만 읽히므로(정적 자산에 CORS 허용 헤더를
 * 주지 않는다) 다른 origin의 페이지가 값을 가져갈 수 없다.
 */
async function sendShellEntryDocument(
  res: Response,
  indexPath: string,
): Promise<void> {
  const document = await readFile(indexPath, 'utf8');
  const token = getConfiguredDevToken();
  const meta = `<meta name="${SHELL_ACCESS_TOKEN_META_NAME}" content="${escapeHtmlAttribute(token)}">`;

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.append('Set-Cookie', buildShellAuthCookieHeader(token));
  res.send(
    document.includes('</head>')
      ? document.replace('</head>', `${meta}</head>`)
      : `${meta}${document}`,
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}
