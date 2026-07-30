import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseVideoArtifactPayload } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';

import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import type { ResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
import {
  commitThreadArtifactVersion,
  loadAllThreadArtifactVersions,
  type CommitThreadArtifactVersionArgs,
} from '../sessions/artifact-store.js';
import {
  statThreadMediaFile,
  writeThreadMediaFile,
} from '../sessions/media-file-store.js';
import { threadMediaDirPath } from '../sessions/paths.js';
import type { PublicHttpReadRuntime } from '../utils/public-http-read-port.js';
import {
  createMediaGenerationRecoveryIdentity,
  ImageGenerationError,
} from './contract.js';
import {
  createVideoGenerationRuntime,
  type VideoGenerationRuntimeDeps,
} from './video-generation-runtime.js';
import { generateVideoViaGrok } from './providers/grok-video-provider.js';

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

function createPublicHttpReadRuntime(
  body: Uint8Array,
  onRequest?: (url: string) => void,
): PublicHttpReadRuntime {
  return {
    async request(input) {
      onRequest?.(input.url);
      return {
        ok: true,
        status: 200,
        location: null,
        contentType: 'video/mp4',
        contentLength: body.byteLength,
        bodyBase64: Buffer.from(body).toString('base64'),
      };
    },
  };
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
    publicHttpRead: createPublicHttpReadRuntime(FAKE_MP4),
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

async function readThreadMediaEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(threadMediaDirPath(root, THREAD_ID))).filter(
      (entry) => entry !== '.generation-operations',
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
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
      publicHttpRead: createPublicHttpReadRuntime(
        new TextEncoder().encode('<html>not a video</html>'),
      ),
    });
    await assert.rejects(
      createVideoGenerationRuntime(deps).generateVideoArtifact(baseInput(root)),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'invalid_video_bytes',
    );
    assert.equal(commits.length, 0);
    // 형식 밖 바이트는 디스크에 닿지 않는다
    assert.deepEqual(await readThreadMediaEntries(root), []);
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

void test('generateVideoArtifact replacement resumes the durably captured provider request instead of creating another job', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-handle-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-handle-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    const seenRequestIds: Array<string | undefined> = [];

    const first = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async (providerInput) => {
          seenRequestIds.push(providerInput.requestId);
          assert.ok(providerInput.onRequestCreated);
          await providerInput.onRequestCreated('request-durable');
          throw new Error('simulated daemon death while polling');
        },
      }).deps,
    );
    await assert.rejects(
      first.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-handle-recovery', identity },
      }),
      /simulated daemon death/u,
    );

    const replacement = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async (providerInput) => {
          seenRequestIds.push(providerInput.requestId);
          return {
            videoUrl: 'https://signed.example/video.mp4',
            durationSeconds: 5,
            model: 'grok-imagine-video-1.5',
          };
        },
        statThreadMediaFileImpl: statThreadMediaFile,
        commitThreadArtifactVersionImpl: commitThreadArtifactVersion,
      }).deps,
    );
    const recovered = await replacement.generateVideoArtifact({
      ...input,
      recovery: { callId: 'call-video-handle-recovery', identity },
    });

    assert.deepEqual(seenRequestIds, [undefined, 'request-durable']);
    assert.equal(recovered.artifactVersion.artifactId, identity.artifactId);
    assert.equal(
      (await loadAllThreadArtifactVersions(root, THREAD_ID)).length,
      1,
    );
  });
});

void test('generateVideoArtifact replacement replays isolated poll and download GETs without another create', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-read-owner-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-read-owner-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    const first = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async (providerInput) => {
          assert.ok(providerInput.onRequestCreated);
          await providerInput.onRequestCreated('request-read-owner');
          throw new Error('simulated daemon death before polling');
        },
      }).deps,
    );
    await assert.rejects(
      first.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-read-owner-recovery', identity },
      }),
      /before polling/u,
    );
    assert.deepEqual(await readThreadMediaEntries(root), []);

    let downloadAttempts = 0;
    const readCalls: Array<{
      method: string;
      url: string;
      maxResponseBytes: number | undefined;
    }> = [];
    const publicHttpRead: PublicHttpReadRuntime = {
      async request(readInput) {
        readCalls.push({
          method: readInput.method,
          url: readInput.url,
          maxResponseBytes: readInput.maxResponseBytes,
        });
        if (readInput.url.endsWith('/videos/request-read-owner')) {
          const body = Buffer.from(
            JSON.stringify({
              status: 'done',
              video: {
                url: 'https://signed.example/recovered.mp4',
                duration: 5,
              },
            }),
          );
          return {
            ok: true,
            status: 200,
            location: null,
            contentType: 'application/json',
            contentLength: body.byteLength,
            bodyBase64: body.toString('base64'),
          };
        }
        assert.equal(readInput.url, 'https://signed.example/recovered.mp4');
        downloadAttempts += 1;
        if (downloadAttempts === 1) {
          return {
            ok: false,
            reasonCode: 'network_error',
            message: 'simulated download interruption',
          };
        }
        return {
          ok: true,
          status: 200,
          location: null,
          contentType: 'video/mp4',
          contentLength: FAKE_MP4.byteLength,
          bodyBase64: Buffer.from(FAKE_MP4).toString('base64'),
        };
      },
    };
    const buildReplacement = () =>
      createVideoGenerationRuntime(
        buildDeps({
          publicHttpRead,
          generateViaGrokImpl: (providerInput) =>
            generateVideoViaGrok({
              ...providerInput,
              sleepImpl: async () => {},
              pollIntervalMs: 1,
              pollTimeoutMs: 1_000,
            }),
          statThreadMediaFileImpl: statThreadMediaFile,
          commitThreadArtifactVersionImpl: commitThreadArtifactVersion,
        }).deps,
      );

    await assert.rejects(
      buildReplacement().generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-read-owner-recovery', identity },
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'provider_network_failed',
    );
    assert.deepEqual(await readThreadMediaEntries(root), []);

    const recovered = await buildReplacement().generateVideoArtifact({
      ...input,
      recovery: { callId: 'call-video-read-owner-recovery', identity },
    });

    assert.deepEqual(
      readCalls.map((call) => [call.method, call.url]),
      [
        ['GET', 'https://api.x.ai/v1/videos/request-read-owner'],
        ['GET', 'https://signed.example/recovered.mp4'],
        ['GET', 'https://api.x.ai/v1/videos/request-read-owner'],
        ['GET', 'https://signed.example/recovered.mp4'],
      ],
    );
    assert.equal(
      readCalls[1]?.maxResponseBytes,
      readCalls[3]?.maxResponseBytes,
    );
    assert.ok((readCalls[3]?.maxResponseBytes ?? 0) >= FAKE_MP4.byteLength);
    assert.equal(downloadAttempts, 2);
    assert.equal(recovered.artifactVersion.artifactId, identity.artifactId);
    assert.match(recovered.media.mediaRef, /^[a-f0-9]{64}\.mp4$/u);
    assert.equal(
      (await loadAllThreadArtifactVersions(root, THREAD_ID)).length,
      1,
    );
  });
});

void test('generateVideoArtifact replacement commits the prepared candidate exactly once after an interrupted settlement', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-candidate-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-candidate-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    let providerRequests = 0;
    let downloads = 0;
    let commitAttempts = 0;
    const generation = async () => {
      providerRequests += 1;
      return {
        videoUrl: 'https://signed.example/video.mp4',
        durationSeconds: 5,
        model: 'grok-imagine-video-1.5',
      };
    };
    const download = createPublicHttpReadRuntime(FAKE_MP4, () => {
      downloads += 1;
    });

    const first = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: generation,
        publicHttpRead: download,
        statThreadMediaFileImpl: statThreadMediaFile,
        commitThreadArtifactVersionImpl: async (commitInput) => {
          commitAttempts += 1;
          await commitThreadArtifactVersion(commitInput);
          throw new Error('simulated daemon death after artifact write');
        },
      }).deps,
    );
    await assert.rejects(
      first.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-candidate-recovery', identity },
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'artifact_commit_failed',
    );

    const replacement = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: generation,
        publicHttpRead: download,
        statThreadMediaFileImpl: statThreadMediaFile,
        commitThreadArtifactVersionImpl: async (commitInput) => {
          commitAttempts += 1;
          return commitThreadArtifactVersion(commitInput);
        },
      }).deps,
    );
    const recovered = await replacement.generateVideoArtifact({
      ...input,
      recovery: { callId: 'call-video-candidate-recovery', identity },
    });

    assert.equal(providerRequests, 1);
    assert.equal(downloads, 1);
    assert.equal(commitAttempts, 2);
    assert.equal(recovered.artifactVersion.artifactId, identity.artifactId);
    assert.equal(recovered.artifactVersion.version, 1);
    assert.equal(
      (await loadAllThreadArtifactVersions(root, THREAD_ID)).length,
      1,
    );
  });
});

void test('generateVideoArtifact replacement fails closed when the provider request id was not durably captured', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-unknown-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-unknown-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    let providerRequests = 0;

    const first = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async () => {
          providerRequests += 1;
          throw new Error('simulated process death before request id response');
        },
      }).deps,
    );
    await assert.rejects(
      first.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-unknown-recovery', identity },
      }),
      /simulated process death/u,
    );

    const replacement = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async () => {
          providerRequests += 1;
          return {
            videoUrl: 'https://signed.example/video.mp4',
            durationSeconds: 5,
            model: 'grok-imagine-video-1.5',
          };
        },
      }).deps,
    );
    await assert.rejects(
      replacement.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-unknown-recovery', identity },
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'provider_outcome_unknown',
    );
    assert.equal(providerRequests, 1);
  });
});

void test('generateVideoArtifact replacement replays one durable create response instead of billing a second provider job', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-create-owner-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-create-owner-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    let providerDispatches = 0;
    let durableResponse: Record<string, unknown> | undefined;
    const providerWebSocketSessions: ResponsesWebSocketSessionStore = {
      acquireWebSocket: async () => {
        throw new Error('video create must not acquire a daemon websocket');
      },
      streamDurableHttpSseEvents: async function* (request) {
        assert.equal(
          request.providerSessionId,
          `media:video:${THREAD_ID}:${identity.operationId}`,
        );
        assert.equal(request.requestAttempt, 0);
        if (durableResponse === undefined) {
          providerDispatches += 1;
          durableResponse = { request_id: 'request-from-owner' };
        }
        yield durableResponse;
      },
    };
    const requestCreate = async (
      providerInput: Parameters<
        NonNullable<VideoGenerationRuntimeDeps['generateViaGrokImpl']>
      >[0],
      serializedPayload = '{"prompt":"a cat"}',
    ) => {
      assert.ok(providerInput.createRequestImpl);
      return providerInput.createRequestImpl({
        requestUrl: 'https://api.x.ai/v1/videos/generations',
        headers: new Headers({
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
        }),
        serializedPayload,
      });
    };

    const first = createVideoGenerationRuntime(
      buildDeps({
        providerWebSocketSessions,
        generateViaGrokImpl: async (providerInput) => {
          await requestCreate(providerInput);
          throw new Error(
            'simulated daemon death before provider handle persistence',
          );
        },
      }).deps,
    );
    await assert.rejects(
      first.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-create-owner-recovery', identity },
      }),
      /before provider handle persistence/u,
    );

    const drifted = createVideoGenerationRuntime(
      buildDeps({
        providerWebSocketSessions,
        generateViaGrokImpl: async (providerInput) => {
          await requestCreate(providerInput, '{"prompt":"a changed cat"}');
          throw new Error('changed request must not reach the provider');
        },
      }).deps,
    );
    await assert.rejects(
      drifted.generateVideoArtifact({
        ...input,
        recovery: { callId: 'call-video-create-owner-recovery', identity },
      }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'provider_outcome_unknown' &&
        /request changed/u.test(error.message),
    );

    const replacement = createVideoGenerationRuntime(
      buildDeps({
        providerWebSocketSessions,
        generateViaGrokImpl: async (providerInput) => {
          const response = await requestCreate(providerInput);
          assert.equal(response['request_id'], 'request-from-owner');
          assert.ok(providerInput.onRequestCreated);
          await providerInput.onRequestCreated('request-from-owner');
          return {
            videoUrl: 'https://signed.example/video.mp4',
            durationSeconds: 5,
            model: 'grok-imagine-video-1.5',
          };
        },
        statThreadMediaFileImpl: statThreadMediaFile,
        commitThreadArtifactVersionImpl: commitThreadArtifactVersion,
      }).deps,
    );
    const recovered = await replacement.generateVideoArtifact({
      ...input,
      recovery: { callId: 'call-video-create-owner-recovery', identity },
    });

    assert.equal(providerDispatches, 1);
    assert.equal(recovered.artifactVersion.artifactId, identity.artifactId);
  });
});

void test('generateVideoArtifact does not mark a provider effect before local auth succeeds', async () => {
  await withTempRoot(async (root) => {
    const input = {
      ...baseInput(root),
      runId: 'run-video-auth-recovery',
    };
    const identity = createMediaGenerationRecoveryIdentity({
      kind: 'video',
      threadId: THREAD_ID,
      runId: input.runId,
      callId: 'call-video-auth-recovery',
      toolArgs: { prompt: input.request.prompt },
    });
    const recovery = {
      callId: 'call-video-auth-recovery',
      identity,
    };

    const disconnected = createVideoGenerationRuntime(
      buildDeps({
        getProviderAuthImpl: async () => {
          throw new Error('provider is not connected');
        },
      }).deps,
    );
    await assert.rejects(
      disconnected.generateVideoArtifact({ ...input, recovery }),
      (error: unknown) =>
        error instanceof ImageGenerationError &&
        error.reasonCode === 'provider_not_connected',
    );

    let providerRequests = 0;
    const replacement = createVideoGenerationRuntime(
      buildDeps({
        generateViaGrokImpl: async () => {
          providerRequests += 1;
          return {
            videoUrl: 'https://signed.example/video.mp4',
            durationSeconds: 5,
            model: 'grok-imagine-video-1.5',
          };
        },
      }).deps,
    );
    await replacement.generateVideoArtifact({ ...input, recovery });
    assert.equal(providerRequests, 1);
  });
});
