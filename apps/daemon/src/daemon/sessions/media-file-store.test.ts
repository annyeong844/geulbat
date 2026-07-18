import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MediaFileTooLargeError,
  copyThreadMediaFiles,
  deleteThreadMediaDir,
  resolveThreadMediaFilePath,
  statThreadMediaFile,
  writeThreadMediaFile,
  writeThreadMediaFileFromStream,
} from './media-file-store.js';
import { threadMediaDirPath } from './paths.js';

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';

async function withTempRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'media-store-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('writeThreadMediaFile stores bytes as <sha256>.<ext> with no temp residue', async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode('fake-mp4-bytes');
    const written = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes,
      maxBytes: 1024,
    });

    const expectedSha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(written.sha256, expectedSha);
    assert.equal(written.mediaRef, `${expectedSha}.mp4`);
    assert.equal(written.byteLength, bytes.byteLength);

    const stored = await statThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      mediaRef: written.mediaRef,
    });
    assert.ok(stored);
    assert.equal(stored.byteLength, bytes.byteLength);
    assert.deepEqual(new Uint8Array(await readFile(stored.path)), bytes);

    // 임시 파일 잔류 없음(§5-8 — 고아 파일 금지)
    const entries = await readdir(threadMediaDirPath(root, THREAD_A));
    assert.deepEqual(entries, [written.mediaRef]);
  });
});

void test('writeThreadMediaFileFromStream enforces the byte limit and cleans up', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      writeThreadMediaFileFromStream({
        workspaceRoot: root,
        threadId: THREAD_A,
        extension: 'mp4',
        stream: (async function* () {
          yield new Uint8Array(64);
          yield new Uint8Array(64);
        })(),
        maxBytes: 100,
      }),
      MediaFileTooLargeError,
    );
    // 한도 초과 시 부분 파일이 남지 않는다
    const entries = await readdir(threadMediaDirPath(root, THREAD_A));
    assert.deepEqual(entries, []);
  });
});

void test('resolveThreadMediaFilePath rejects refs outside the closed pattern', () => {
  const sha = 'a'.repeat(64);
  assert.notEqual(
    resolveThreadMediaFilePath({
      workspaceRoot: '/root',
      threadId: THREAD_A,
      mediaRef: `${sha}.mp4`,
    }),
    null,
  );
  for (const bad of [
    '../escape.mp4',
    `${sha}.exe`,
    `${sha}`,
    'short.mp4',
    `${sha}.mp4/../x`,
  ]) {
    assert.equal(
      resolveThreadMediaFilePath({
        workspaceRoot: '/root',
        threadId: THREAD_A,
        mediaRef: bad,
      }),
      null,
      `expected rejection for: ${bad}`,
    );
  }
});

void test('copyThreadMediaFiles copies into the target thread and fails closed on missing sources', async () => {
  await withTempRoot(async (root) => {
    const written = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes: new TextEncoder().encode('branch-me'),
      maxBytes: 1024,
    });

    const copied = await copyThreadMediaFiles({
      workspaceRoot: root,
      sourceThreadId: THREAD_A,
      targetThreadId: THREAD_B,
      mediaRefs: [written.mediaRef],
    });
    assert.equal(copied, 1);
    assert.ok(
      await statThreadMediaFile({
        workspaceRoot: root,
        threadId: THREAD_B,
        mediaRef: written.mediaRef,
      }),
    );

    // 소스에 없는 참조는 조용히 넘기지 않는다(fail-closed)
    await assert.rejects(
      copyThreadMediaFiles({
        workspaceRoot: root,
        sourceThreadId: THREAD_A,
        targetThreadId: THREAD_B,
        mediaRefs: [`${'b'.repeat(64)}.mp4`],
      }),
    );
  });
});

void test('deleteThreadMediaDir removes the media directory and tolerates absence', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await deleteThreadMediaDir(root, THREAD_A), false);

    const written = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes: new TextEncoder().encode('to-delete'),
      maxBytes: 1024,
    });
    assert.equal(await deleteThreadMediaDir(root, THREAD_A), true);
    assert.equal(
      await statThreadMediaFile({
        workspaceRoot: root,
        threadId: THREAD_A,
        mediaRef: written.mediaRef,
      }),
      null,
    );
  });
});

void test('statThreadMediaFile does not see other threads media (isolation)', async () => {
  await withTempRoot(async (root) => {
    const written = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes: new TextEncoder().encode('mine-only'),
      maxBytes: 1024,
    });
    // 같은 mediaRef라도 스레드가 다르면 보이지 않는다
    assert.equal(
      await statThreadMediaFile({
        workspaceRoot: root,
        threadId: THREAD_B,
        mediaRef: written.mediaRef,
      }),
      null,
    );
  });
});

void test('writeThreadMediaFile is idempotent for identical bytes', async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode('same-content');
    const first = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes,
      maxBytes: 1024,
    });
    const second = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_A,
      extension: 'mp4',
      bytes,
      maxBytes: 1024,
    });
    assert.equal(first.mediaRef, second.mediaRef);
    const entries = await readdir(threadMediaDirPath(root, THREAD_A));
    assert.deepEqual(entries, [first.mediaRef]);
  });
});

void test('media dir path lives in the dedicated .geulbat/media tree', async () => {
  await withTempRoot(async (root) => {
    // 잘못된 threadId는 경로 조립 전에 거부된다
    await assert.rejects(
      writeThreadMediaFile({
        workspaceRoot: root,
        threadId: '../escape',
        extension: 'mp4',
        bytes: new Uint8Array(1),
        maxBytes: 10,
      }),
    );
    // 삭제도 동일
    await assert.rejects(deleteThreadMediaDir(root, '../escape'));
    // 무거운 생성물은 세션 텍스트 상태와 분리된 .geulbat/media/<thread>에
    // 산다(사용자 결정 2026-07-13) — sessions/ 아래가 아니다.
    await writeFile(join(root, 'marker'), 'x');
    const dir = threadMediaDirPath(root, THREAD_A);
    assert.ok(dir.includes(join('.geulbat', 'media', THREAD_A)));
    assert.ok(!dir.includes('sessions'));
  });
});
