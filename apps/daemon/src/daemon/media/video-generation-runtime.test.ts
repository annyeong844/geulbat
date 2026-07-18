import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseVideoArtifactPayload } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';

import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import type { CommitThreadArtifactVersionArgs } from '../sessions/artifact-store.js';
import { writeThreadMediaFile } from '../sessions/media-file-store.js';
import { threadMediaDirPath } from '../sessions/paths.js';
import { ImageGenerationError } from './contract.js';
import {
  createVideoGenerationRuntime,
  type VideoGenerationRuntimeDeps,
} from './video-generation-runtime.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111' as ThreadId;
const OTHER_THREAD_ID = '22222222-2222-4222-8222-222222222222' as ThreadId;

// mp4 매직 바이트(ftyp) 헤더를 가진 가짜 동영상
const FAKE_MP4 = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x20,
  0x66,
  0x74,
  0x79,
  0x70,
  0x69,
  0x73,
  0x6f,
  0x6d,
  ...Array.from({ length: 64 }, (_, index) => index % 251),
]);

interface CommitCall {
  renderer: string;
  payload: string;
  digest: string | null;
  title: string | null | undefined;
}

function buildDeps(overrides: Partial<VideoGenerationRuntimeDeps>): {
  deps: VideoGenerationRuntimeDeps;
  commits: CommitCall[];
} {
  const commits: CommitCall[] = [];
  const deps: VideoGenerationRuntimeDeps = {
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    getProviderAuthImpl: async () => ({
      accessToken: 'access-token',
      accountId: 'acct',
    }),
    forceRefreshProviderAuthImpl: async () => ({
      accessToken: 'refreshed-token',
      accountId: 'acct',
    }),
    generateViaGrokImpl: async () => ({
      videoUrl: 'https://signed.example/video.mp4',
      durationSeconds: 5,
      model: 'grok-imagine-video-1.5',
    }),
    downloadFetchImpl: async () => new Response(FAKE_MP4, { status: 200 }),
    commitThreadArtifactVersionImpl: async (
      args: CommitThreadArtifactVersionArgs,
    ) => {
      commits.push({
        renderer: args.renderer,
        payload: args.payload,
        digest: args.digest,
        title: args.title,
      });
      return {
        artifact: {
          artifactId: 'art_video',
          threadId: args.threadId,
          renderer: args.renderer,
          title: args.title ?? null,
          sourceRef: args.sourceRef,
          latestVersion: 1,
          persistenceEpoch: 0,
          createdAt: args.timestamp,
          updatedAt: args.timestamp,
        },
        version: {
          artifactId: 'art_video',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: args.renderer,
          payload: args.payload,
          digest: args.digest,
          contentHash: 'hash',
          createdAt: args.timestamp,
          createdByRunId: args.runId,
          previewValidation: { ok: true },
        },
        ref: { artifactId: 'art_video', version: 1 },
      };
    },
    now: () => '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
  return { deps, commits };
}

async function withTempRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'video-runtime-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseInput(stateRoot: string) {
  return {
    request: { prompt: 'a waving watercolor cat' },
    stateRoot,
    workingDirectory: 'workspace',
    threadId: THREAD_ID,
    runId: 'run-video-1',
  };
}

void test('generateVideoArtifact bridges text prompts with the blank canvas and commits a thread_media manifest', async () => {
  await withTempRoot(async (root) => {
    let seenSourceDataUrl: string | undefined;
    let seenDuration: number | undefined;
    const { deps, commits } = buildDeps({
      generateViaGrokImpl: async (input) => {
        seenSourceDataUrl = input.sourceImageDataUrl;
        seenDuration = input.request.durationSeconds;
        return {
          videoUrl: 'https://signed.example/video.mp4',
          durationSeconds: input.request.durationSeconds,
          model: 'grok-imagine-video-1.5',
        };
      },
    });
    const runtime = createVideoGenerationRuntime(deps);

    const result = await runtime.generateVideoArtifact(baseInput(root));

    // 투명 캔버스 브리지(D-V5) + duration 내장 기본값 5초(§4.1 사다리)
    assert.ok(seenSourceDataUrl?.startsWith('data:image/png;base64,'));
    assert.equal(seenDuration, 5);
    assert.equal(result.provenance.sourceImage, 'blank_canvas');
    assert.equal(result.media.mimeType, 'video/mp4');
    assert.equal(result.media.byteLength, FAKE_MP4.byteLength);

    // 커밋된 payload는 규범 매니페스트여야 하고 인라인 바이트가 없어야 한다
    assert.equal(commits.length, 1);
    const manifest = parseVideoArtifactPayload(commits[0]!.payload);
    assert.ok(manifest);
    assert.equal(manifest.source.mediaRef, result.media.mediaRef);
    assert.equal(manifest.durationSeconds, 5);
    assert.ok(!commits[0]!.payload.includes('base64'));

    // media 파일이 실제로 존재하고 mediaRef=sha256.mp4 형식이다
    const entries = await readdir(threadMediaDirPath(root, THREAD_ID));
    assert.deepEqual(entries, [result.media.mediaRef]);
  });
});

void test('generateVideoArtifact animates a same-thread image artifact and records its ref', async () => {
  await withTempRoot(async (root) => {
    const imageBase64 = Buffer.from('image-bytes').toString('base64');
    const imagePayload = JSON.stringify({
      schemaVersion: 1,
      kind: 'generated_image',
      mimeType: 'image/jpeg',
      byteLength: 11,
      digest: { algorithm: 'sha256', encoding: 'hex', value: 'a'.repeat(64) },
      source: { type: 'inline_base64', dataBase64: imageBase64 },
      provenance: {
        providerId: 'grok_oauth',
        model: 'grok-imagine-image-quality',
        capability: 'image_generation',
        prompt: 'a cat',
        generatedAt: '2026-07-13T00:00:00.000Z',
      },
    });
    let seenSourceDataUrl: string | undefined;
    const { deps } = buildDeps({
      loadThreadArtifactVersionsByRefsImpl: async (_root, threadId, refs) => {
        // 스레드 스코프 조회 — 다른 스레드에서는 아무것도 안 나온다
        if (threadId !== THREAD_ID) {
          return [];
        }
        assert.deepEqual(refs, [{ artifactId: 'art_img', version: 2 }]);
        return [
          {
            artifactId: 'art_img',
            version: 2,
            parentVersion: null,
            baseVersion: null,
            renderer: 'image',
            payload: imagePayload,
            digest: null,
            contentHash: 'hash',
            createdAt: '2026-07-13T00:00:00.000Z',
            createdByRunId: 'run-img',
            previewValidation: { ok: true },
            title: null,
            persistenceEpoch: 0,
            sourceRef: null,
          },
        ];
      },
      generateViaGrokImpl: async (input) => {
        seenSourceDataUrl = input.sourceImageDataUrl;
        return {
          videoUrl: 'https://signed.example/video.mp4',
          durationSeconds: 5,
          model: 'grok-imagine-video-1.5',
        };
      },
    });
    const runtime = createVideoGenerationRuntime(deps);

    const result = await runtime.generateVideoArtifact({
      ...baseInput(root),
      sourceArtifactRef: 'art_img@2',
    });
    assert.equal(seenSourceDataUrl, `data:image/jpeg;base64,${imageBase64}`);
    assert.deepEqual(result.provenance.sourceImage, {
      artifactRef: 'art_img@2',
    });
  });
});

void test('generateVideoArtifact reads a thread_media image source from the file store (S4b)', async () => {
  await withTempRoot(async (root) => {
    // 신형 이미지 아티팩트: 바이트는 media 스토어에, 매니페스트는 mediaRef만
    const imageBytes = new TextEncoder().encode('real-image-bytes');
    const written = await writeThreadMediaFile({
      workspaceRoot: root,
      threadId: THREAD_ID,
      extension: 'jpg',
      bytes: imageBytes,
      maxBytes: 4096,
    });
    const imagePayload = JSON.stringify({
      schemaVersion: 1,
      kind: 'generated_image',
      mimeType: 'image/jpeg',
      byteLength: imageBytes.byteLength,
      digest: { algorithm: 'sha256', encoding: 'hex', value: written.sha256 },
      source: { type: 'thread_media', mediaRef: written.mediaRef },
      provenance: {
        providerId: 'grok_oauth',
        model: 'grok-imagine-image-quality',
        capability: 'image_generation',
        prompt: 'a cat',
        generatedAt: '2026-07-13T00:00:00.000Z',
      },
    });
    let seenSourceDataUrl: string | undefined;
    const { deps } = buildDeps({
      loadThreadArtifactVersionsByRefsImpl: async () => [
        {
          artifactId: 'art_img',
          version: 3,
          parentVersion: null,
          baseVersion: null,
          renderer: 'image',
          payload: imagePayload,
          digest: null,
          contentHash: 'hash',
          createdAt: '2026-07-13T00:00:00.000Z',
          createdByRunId: 'run-img',
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 0,
          sourceRef: null,
        },
      ],
      generateViaGrokImpl: async (input) => {
        seenSourceDataUrl = input.sourceImageDataUrl;
        return {
          videoUrl: 'https://signed.example/video.mp4',
          durationSeconds: 5,
          model: 'grok-imagine-video-1.5',
        };
      },
    });

    const result = await createVideoGenerationRuntime(
      deps,
    ).generateVideoArtifact({
      ...baseInput(root),
      sourceArtifactRef: 'art_img@3',
    });
    // 파일 스토어에서 읽어 data URL로 넘긴다(바이트 왕복 확인)
    assert.equal(
      seenSourceDataUrl,
      `data:image/jpeg;base64,${Buffer.from(imageBytes).toString('base64')}`,
    );
    assert.deepEqual(result.provenance.sourceImage, {
      artifactRef: 'art_img@3',
    });
  });
});

void test('generateVideoArtifact fails closed on missing, non-image, or malformed source artifacts', async () => {
  await withTempRoot(async (root) => {
    const { deps } = buildDeps({
      loadThreadArtifactVersionsByRefsImpl: async () => [],
    });
    const runtime = createVideoGenerationRuntime(deps);

    await assert.rejects(
      runtime.generateVideoArtifact({
        ...baseInput(root),
        sourceArtifactRef: 'not-a-ref',
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'source_artifact_ref_invalid',
    );
    await assert.rejects(
      runtime.generateVideoArtifact({
        ...baseInput(root),
        sourceArtifactRef: 'art_missing@1',
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'source_artifact_not_found',
    );

    const { deps: nonImageDeps } = buildDeps({
      loadThreadArtifactVersionsByRefsImpl: async () => [
        {
          artifactId: 'art_md',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: 'markdown',
          payload: '# hello',
          digest: null,
          contentHash: 'hash',
          createdAt: '2026-07-13T00:00:00.000Z',
          createdByRunId: 'run-md',
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 0,
          sourceRef: null,
        },
      ],
    });
    await assert.rejects(
      createVideoGenerationRuntime(nonImageDeps).generateVideoArtifact({
        ...baseInput(root),
        sourceArtifactRef: 'art_md@1',
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'source_artifact_not_image',
    );
  });
});

void test('generateVideoArtifact rejects non-video bytes before touching disk', async () => {
  await withTempRoot(async (root) => {
    const { deps, commits } = buildDeps({
      downloadFetchImpl: async () =>
        new Response(new TextEncoder().encode('<html>not a video</html>'), {
          status: 200,
        }),
    });
    await assert.rejects(
      createVideoGenerationRuntime(deps).generateVideoArtifact(baseInput(root)),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'invalid_video_bytes',
    );
    assert.equal(commits.length, 0);
    // 형식 밖 바이트는 디스크에 닿지 않는다
    await assert.rejects(readdir(threadMediaDirPath(root, THREAD_ID)));
  });
});

void test('generateVideoArtifact cleans up the media file when the commit fails', async () => {
  await withTempRoot(async (root) => {
    const { deps } = buildDeps({
      commitThreadArtifactVersionImpl: async () => {
        throw new Error('disk full');
      },
    });
    await assert.rejects(
      createVideoGenerationRuntime(deps).generateVideoArtifact(baseInput(root)),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'artifact_commit_failed',
    );
    // 고아 파일 없음(§5-8)
    const entries = await readdir(threadMediaDirPath(root, THREAD_ID));
    assert.deepEqual(entries, []);
  });
});

void test('generateVideoArtifact retries once with a forced refresh on auth rejection', async () => {
  await withTempRoot(async (root) => {
    let attempts = 0;
    let refreshes = 0;
    const { deps } = buildDeps({
      generateViaGrokImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ImageGenerationError({
            surface: 'provider_auth',
            reasonCode: 'provider_auth_rejected',
            message: 'rejected',
          });
        }
        return {
          videoUrl: 'https://signed.example/video.mp4',
          durationSeconds: 5,
          model: 'grok-imagine-video-1.5',
        };
      },
      forceRefreshProviderAuthImpl: async () => {
        refreshes += 1;
        return { accessToken: 'refreshed', accountId: 'acct' };
      },
    });
    const result = await createVideoGenerationRuntime(
      deps,
    ).generateVideoArtifact(baseInput(root));
    assert.equal(attempts, 2);
    assert.equal(refreshes, 1);
    assert.equal(result.media.mimeType, 'video/mp4');
  });
});

void test('withRequestDefaults isolates concurrent runs (singleton stays untouched)', async () => {
  await withTempRoot(async (root) => {
    const seenDurations: number[] = [];
    const { deps } = buildDeps({
      generateViaGrokImpl: async (input) => {
        seenDurations.push(input.request.durationSeconds);
        return {
          videoUrl: 'https://signed.example/video.mp4',
          durationSeconds: input.request.durationSeconds,
          model: input.request.model ?? 'grok-imagine-video-1.5',
        };
      },
    });
    const singleton = createVideoGenerationRuntime(deps);
    const runA = singleton.withRequestDefaults({
      model: 'grok-imagine-video-1.5',
      durationSeconds: 10,
    });

    await runA.generateVideoArtifact(baseInput(root));
    await singleton.generateVideoArtifact({
      ...baseInput(root),
      threadId: OTHER_THREAD_ID,
    });
    // 파생 런타임은 10초, 싱글턴은 내장 기본 5초 — 서로 오염되지 않는다
    assert.deepEqual(seenDurations, [10, 5]);
  });
});
