import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createThreadsRoutes } from './threads.js';
import { writeThreadMediaFile } from '../../../daemon/sessions/media-file-store.js';

// media 서빙 라우트(video-generation-open §4.6) 계약 테스트.
// 인증은 서버 레벨 미들웨어 소관이라 여기서는 경로 가드·Range·격리를 본다.

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';

interface MediaRouteHarness {
  baseUrl: string;
  root: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<MediaRouteHarness> {
  const root = await mkdtemp(join(tmpdir(), 'media-route-'));
  const app = express();
  app.use(
    createThreadsRoutes({
      context: {
        homeStateRoot: root,
        activeRuns: { getRunByThreadId: () => undefined },
        backgroundNotifications: { clearThreadBackgroundResults() {} },
        providerTransitionCompaction: {
          async prepare() {
            throw new Error('provider transition is outside this harness');
          },
        },
      },
    }),
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

void test('media route serves full bytes, honors single Range, and isolates threads', async () => {
  const harness = await startHarness();
  try {
    const bytes = new TextEncoder().encode('0123456789abcdef');
    const written = await writeThreadMediaFile({
      workspaceRoot: harness.root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes,
      maxBytes: 1024,
    });
    const url = `${harness.baseUrl}/api/threads/${THREAD_A}/media/${written.mediaRef}`;

    // 전체 응답
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), String(bytes.length));
    assert.equal(await full.text(), '0123456789abcdef');

    // 단일 Range → 206 + Content-Range
    const partial = await fetch(url, { headers: { Range: 'bytes=4-7' } });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get('content-range'),
      `bytes 4-7/${bytes.length}`,
    );
    assert.equal(await partial.text(), '4567');

    // 열린 끝 Range와 suffix Range
    const openEnded = await fetch(url, { headers: { Range: 'bytes=12-' } });
    assert.equal(openEnded.status, 206);
    assert.equal(await openEnded.text(), 'cdef');
    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), 'def');

    // 범위 밖 시작점 → 416
    const beyond = await fetch(url, { headers: { Range: 'bytes=99-' } });
    assert.equal(beyond.status, 416);
    assert.equal(
      beyond.headers.get('content-range'),
      `bytes */${bytes.length}`,
    );

    // 타 스레드 격리 — 같은 mediaRef라도 B 스레드 경로에서는 404
    const crossThread = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_B}/media/${written.mediaRef}`,
    );
    assert.equal(crossThread.status, 404);

    // 형식 밖 mediaRef는 bad_request (경로 탈출 원천 차단)
    const badRef = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_A}/media/${'a'.repeat(64)}.exe`,
    );
    assert.equal(badRef.status, 400);

    // 존재하지 않는 sha → 404
    const missing = await fetch(
      `${harness.baseUrl}/api/threads/${THREAD_A}/media/${'b'.repeat(64)}.mp4`,
    );
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});
