import { readFile, rm } from 'node:fs/promises';

import {
  parseImageArtifactPayload,
  VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
  type VideoArtifactPayloadV1,
} from '@geulbat/protocol/artifacts';

import { forceRefreshProviderAuth, getProviderAuth } from '../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import { normalizeProviderErrorCode } from '../llm/provider/provider-error.js';
import {
  commitThreadArtifactVersion,
  loadThreadArtifactVersionsByRefs,
} from '../sessions/artifact-store.js';
import {
  MediaFileTooLargeError,
  resolveThreadMediaFilePath,
  writeThreadMediaFileFromStream,
  type ThreadMediaExtension,
  type WrittenThreadMediaFile,
} from '../sessions/media-file-store.js';
import { blankCanvasDataUrl } from './blank-canvas.js';
import {
  ImageGenerationError,
  type GenerateVideoArtifactInput,
  type GenerateVideoArtifactResult,
  type GeneratedVideoProvenance,
  type VideoGenerationRuntime,
} from './contract.js';
import { generateVideoViaGrok } from './providers/grok-video-provider.js';
import { withVideoGenerationRequestDefaults } from './video-generation-request-defaults.js';

// 동영상 생성의 데몬-프라이빗 진입점(video-generation-open §4.5) —
// 소스 이미지 해석(투명 캔버스 브리지 포함) → 프로바이더 잡 → video.url
// 스트리밍 다운로드 → 매직바이트/크기 검증 → media 파일 스토어 →
// 매니페스트 커밋까지를 소유한다. 인라인 base64는 만들지 않는다(D-V7).

export interface VideoGenerationRuntimeDeps {
  providerAuthRuntime: ProviderAuthRuntimeStore;
  getProviderAuthImpl?: typeof getProviderAuth;
  forceRefreshProviderAuthImpl?: typeof forceRefreshProviderAuth;
  generateViaGrokImpl?: typeof generateVideoViaGrok;
  downloadFetchImpl?: typeof fetch;
  commitThreadArtifactVersionImpl?: typeof commitThreadArtifactVersion;
  loadThreadArtifactVersionsByRefsImpl?: typeof loadThreadArtifactVersionsByRefs;
  writeThreadMediaFileFromStreamImpl?: typeof writeThreadMediaFileFromStream;
  now?: () => string;
}

// duration 사다리의 마지막 단(§4.1) — 사용자 무선택·env 무설정 시 5초.
const DEFAULT_VIDEO_DURATION_SECONDS = 5;

function resolveDefaultVideoDurationSeconds(): number {
  const raw = process.env.GEULBAT_VIDEO_GENERATION_DEFAULT_DURATION_SECONDS;
  if (raw === undefined) {
    return DEFAULT_VIDEO_DURATION_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 15
    ? parsed
    : DEFAULT_VIDEO_DURATION_SECONDS;
}

// 파일 크기 정책 — 이미지 32MB의 동영상판(§4.5, 기본 256MB, env knob)
const DEFAULT_VIDEO_MAX_BYTES = 256 * 1024 * 1024;

function resolveVideoMaxBytes(): number {
  const raw = process.env.GEULBAT_VIDEO_GENERATION_MAX_BYTES;
  if (raw === undefined) {
    return DEFAULT_VIDEO_MAX_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_VIDEO_MAX_BYTES;
}

const VIDEO_ARTIFACT_TITLE_MAX_LENGTH = 80;

function buildVideoArtifactTitle(prompt: string): string {
  const singleLine = prompt.replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= VIDEO_ARTIFACT_TITLE_MAX_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, VIDEO_ARTIFACT_TITLE_MAX_LENGTH - 1)}…`;
}

function isProviderAuthFailure(error: unknown): boolean {
  if (error instanceof ImageGenerationError) {
    return error.surface === 'provider_auth';
  }
  return normalizeProviderErrorCode(error) === 'llm_auth_failed';
}

function isProviderNotConnectedFailure(error: unknown): boolean {
  return (
    error instanceof ImageGenerationError &&
    error.reasonCode === 'provider_not_connected'
  );
}

export function createVideoGenerationRuntime(
  deps: VideoGenerationRuntimeDeps,
): VideoGenerationRuntime {
  const runtime: VideoGenerationRuntime = {
    async generateVideoArtifact(
      input: GenerateVideoArtifactInput,
    ): Promise<GenerateVideoArtifactResult> {
      const source = await resolveSourceImage(input, deps);
      const generated = await generateWithAuthRetry(input, deps, source);
      return downloadValidateAndCommit(input, deps, source, generated);
    },
    withRequestDefaults(defaults) {
      return withVideoGenerationRequestDefaults(runtime, defaults);
    },
  };
  return runtime;
}

interface ResolvedSourceImage {
  dataUrl: string;
  provenance: GeneratedVideoProvenance['sourceImage'];
}

// 소스 이미지 해석(§4.3) — sourceArtifactRef는 이 스레드의 이미지 아티팩트만
// 허용한다. 타 스레드 ref는 스레드 스코프 스토어에서 애초에 조회되지 않아
// not-found로 끝난다(경로 격리). 없으면 투명 캔버스 브리지(D-V5).
async function resolveSourceImage(
  input: GenerateVideoArtifactInput,
  deps: VideoGenerationRuntimeDeps,
): Promise<ResolvedSourceImage> {
  if (input.sourceArtifactRef === undefined) {
    return { dataUrl: blankCanvasDataUrl(), provenance: 'blank_canvas' };
  }

  const match = /^(.+)@(\d+)$/u.exec(input.sourceArtifactRef);
  const artifactId = match?.[1];
  const versionText = match?.[2];
  if (artifactId === undefined || versionText === undefined) {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_ref_invalid',
      message: `sourceArtifactRef must look like "artifactId@version": ${input.sourceArtifactRef}`,
    });
  }
  const load =
    deps.loadThreadArtifactVersionsByRefsImpl ??
    loadThreadArtifactVersionsByRefs;
  const versions = await load(input.stateRoot, input.threadId, [
    { artifactId, version: Number(versionText) },
  ]);
  const version = versions[0];
  if (version === undefined) {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_not_found',
      message: `source artifact was not found in this thread: ${input.sourceArtifactRef}`,
    });
  }
  if (version.renderer !== 'image') {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_not_image',
      message: `source artifact is not an image (renderer: ${version.renderer})`,
    });
  }
  const payload = parseImageArtifactPayload(version.payload);
  if (payload === null) {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_payload_invalid',
      message: 'source image artifact payload could not be parsed',
    });
  }
  // 이미지 소스는 두 형태를 지원한다(S4b 이관 전후 하위호환):
  // - inline_base64(구): 매니페스트에 바이트가 들어있어 그대로 data URL.
  // - thread_media(신): media 파일 스토어에서 바이트를 읽어 data URL로.
  const dataBase64 =
    payload.source.type === 'inline_base64'
      ? payload.source.dataBase64
      : await readThreadMediaAsBase64(input, payload.source.mediaRef);
  return {
    dataUrl: `data:${payload.mimeType};base64,${dataBase64}`,
    provenance: { artifactRef: input.sourceArtifactRef },
  };
}

async function readThreadMediaAsBase64(
  input: GenerateVideoArtifactInput,
  mediaRef: string,
): Promise<string> {
  const path = resolveThreadMediaFilePath({
    workspaceRoot: input.stateRoot,
    threadId: input.threadId,
    mediaRef,
  });
  if (path === null) {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_payload_invalid',
      message: 'source image media reference is malformed',
    });
  }
  try {
    return (await readFile(path)).toString('base64');
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_not_found',
      message: 'source image media file could not be read',
      cause: error,
    });
  }
}

async function acquireProviderAuthOrFailClosed<T>(
  acquire: () => Promise<T>,
): Promise<T> {
  try {
    return await acquire();
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'provider_auth',
      reasonCode: 'provider_not_connected',
      message:
        'video provider grok_oauth is not connected or its credential is unavailable',
      cause: error,
    });
  }
}

async function generateWithAuthRetry(
  input: GenerateVideoArtifactInput,
  deps: VideoGenerationRuntimeDeps,
  source: ResolvedSourceImage,
): Promise<Awaited<ReturnType<typeof generateVideoViaGrok>>> {
  try {
    return await generateVideoOnce(input, deps, source, {
      allowRefresh: true,
    });
  } catch (error: unknown) {
    if (
      isProviderNotConnectedFailure(error) ||
      !isProviderAuthFailure(error) ||
      input.signal?.aborted === true
    ) {
      throw error;
    }
    // 잡 시작 전 401만 여기 온다 — 한 번의 강제 리프레시 후 재시도(승계)
    const forceRefresh =
      deps.forceRefreshProviderAuthImpl ?? forceRefreshProviderAuth;
    await forceRefresh({
      providerId: 'grok_oauth',
      runtimeStore: deps.providerAuthRuntime,
    });
    return await generateVideoOnce(input, deps, source, {
      allowRefresh: false,
    });
  }
}

async function generateVideoOnce(
  input: GenerateVideoArtifactInput,
  deps: VideoGenerationRuntimeDeps,
  source: ResolvedSourceImage,
  options: { allowRefresh: boolean },
): Promise<Awaited<ReturnType<typeof generateVideoViaGrok>>> {
  const getAuth = deps.getProviderAuthImpl ?? getProviderAuth;
  const auth = await acquireProviderAuthOrFailClosed(() =>
    getAuth({
      providerId: 'grok_oauth',
      allowRefresh: options.allowRefresh,
      runtimeStore: deps.providerAuthRuntime,
    }),
  );
  const generate = deps.generateViaGrokImpl ?? generateVideoViaGrok;
  return generate({
    request: {
      prompt: input.request.prompt,
      durationSeconds:
        input.request.durationSeconds ?? resolveDefaultVideoDurationSeconds(),
      ...(input.request.model !== undefined
        ? { model: input.request.model }
        : {}),
      ...(input.request.aspectRatio !== undefined
        ? { aspectRatio: input.request.aspectRatio }
        : {}),
      ...(input.request.resolution !== undefined
        ? { resolution: input.request.resolution }
        : {}),
    },
    sourceImageDataUrl: source.dataUrl,
    auth: { accessToken: auth.accessToken },
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}

// 매직 바이트 스니핑 — mp4(ftyp)·webm(EBML)만 통과(§4.5-4). 확장자는
// 스니핑 결과가 정하므로 업스트림 Content-Type을 신뢰하지 않는다.
function sniffVideoContainer(
  head: Uint8Array,
): { mimeType: string; extension: ThreadMediaExtension } | null {
  if (
    head.byteLength >= 12 &&
    head[4] === 0x66 &&
    head[5] === 0x74 &&
    head[6] === 0x79 &&
    head[7] === 0x70
  ) {
    return { mimeType: 'video/mp4', extension: 'mp4' };
  }
  if (
    head.byteLength >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return { mimeType: 'video/webm', extension: 'webm' };
  }
  return null;
}

function asVideoByteChunk(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

interface DownloadedVideo {
  written: WrittenThreadMediaFile;
  mimeType: string;
}

async function downloadVideoToMediaStore(
  input: GenerateVideoArtifactInput,
  deps: VideoGenerationRuntimeDeps,
  videoUrl: string,
): Promise<DownloadedVideo> {
  const fetchImpl = deps.downloadFetchImpl ?? fetch;
  let response: Response;
  try {
    // 서명 URL은 TTL 불명 — 즉시 1회 다운로드, 재시도 없음(§4.5-3)
    response = await fetchImpl(videoUrl, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (error: unknown) {
    if (input.signal?.aborted === true) {
      throw error;
    }
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_network_failed',
      message: 'generated video could not be downloaded',
      cause: error,
    });
  }
  if (!response.ok || response.body === null) {
    throw new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_response_invalid',
      message: `generated video download failed (status ${response.status})`,
    });
  }

  // 첫 청크로 컨테이너를 스니핑한 뒤에야 파일 쓰기를 시작한다 — 형식 밖
  // 바이트는 디스크에 닿지 않는다(fail-closed).
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstChunk =
    first.done === true ? new Uint8Array(0) : asVideoByteChunk(first.value);
  const container =
    firstChunk === null ? null : sniffVideoContainer(firstChunk);
  if (firstChunk === null || container === null) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'invalid_video_bytes',
      message: 'downloaded bytes are not a supported video container',
    });
  }

  const write =
    deps.writeThreadMediaFileFromStreamImpl ?? writeThreadMediaFileFromStream;
  try {
    const written = await write({
      workspaceRoot: input.stateRoot,
      threadId: input.threadId,
      extension: container.extension,
      stream: (async function* () {
        try {
          yield firstChunk;
          while (true) {
            const next = await reader.read();
            if (next.done === true) {
              return;
            }
            const nextChunk = asVideoByteChunk(next.value);
            if (nextChunk === null) {
              throw new ImageGenerationError({
                surface: 'candidate_validation',
                reasonCode: 'invalid_video_bytes',
                message: 'downloaded bytes are not a supported video container',
              });
            }
            yield nextChunk;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
      maxBytes: resolveVideoMaxBytes(),
    });
    return { written, mimeType: container.mimeType };
  } catch (error: unknown) {
    if (error instanceof MediaFileTooLargeError) {
      throw new ImageGenerationError({
        surface: 'candidate_validation',
        reasonCode: 'video_too_large',
        message: `generated video exceeds the size policy (${error.byteLimit} bytes)`,
        cause: error,
      });
    }
    throw error;
  }
}

// 방어적 cleanup — 경로 해석/삭제 실패가 원래 오류를 가리지 않게 삼킨다.
async function removeWrittenMediaFile(
  input: GenerateVideoArtifactInput,
  mediaRef: string,
): Promise<void> {
  try {
    const path = resolveThreadMediaFilePath({
      workspaceRoot: input.stateRoot,
      threadId: input.threadId,
      mediaRef,
    });
    if (path !== null) {
      await rm(path, { force: true });
    }
  } catch {
    // cleanup 실패는 무시한다(원래 오류 우선).
  }
}

async function downloadValidateAndCommit(
  input: GenerateVideoArtifactInput,
  deps: VideoGenerationRuntimeDeps,
  source: ResolvedSourceImage,
  generated: Awaited<ReturnType<typeof generateVideoViaGrok>>,
): Promise<GenerateVideoArtifactResult> {
  const downloaded = await downloadVideoToMediaStore(
    input,
    deps,
    generated.videoUrl,
  );

  // 취소/timeout 후 늦은 커밋 금지(§5-8) — 커밋 직전에 확인하고, 실패·취소
  // 경로에서는 방금 쓴 파일을 정리해 고아를 남기지 않는다.
  if (input.signal?.aborted === true) {
    await removeWrittenMediaFile(input, downloaded.written.mediaRef);
    throw new Error('video generation was aborted before commit');
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const provenance: GeneratedVideoProvenance = {
    providerId: 'grok_oauth',
    model: generated.model,
    capability: 'video_generation',
    prompt: input.request.prompt,
    sourceImage: source.provenance,
    generatedAt: timestamp,
  };
  const manifest: VideoArtifactPayloadV1 = {
    schemaVersion: VIDEO_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
    kind: 'generated_video',
    mimeType: downloaded.mimeType,
    byteLength: downloaded.written.byteLength,
    digest: {
      algorithm: 'sha256',
      encoding: 'hex',
      value: downloaded.written.sha256,
    },
    source: { type: 'thread_media', mediaRef: downloaded.written.mediaRef },
    durationSeconds: generated.durationSeconds,
    provenance,
  };

  const commit =
    deps.commitThreadArtifactVersionImpl ?? commitThreadArtifactVersion;
  let committed: Awaited<ReturnType<typeof commitThreadArtifactVersion>>;
  try {
    committed = await commit({
      workspaceRoot: input.stateRoot,
      threadId: input.threadId,
      runId: input.runId,
      renderer: 'video',
      payload: JSON.stringify(manifest),
      digest: downloaded.written.sha256,
      title: buildVideoArtifactTitle(input.request.prompt),
      sourceRef: {
        kind: 'thread',
        workingDirectory: input.workingDirectory,
        threadId: input.threadId,
        runId: input.runId,
        filePath: null,
        messageTimestamp: timestamp,
      },
      timestamp,
    });
  } catch (error: unknown) {
    await removeWrittenMediaFile(input, downloaded.written.mediaRef);
    throw new ImageGenerationError({
      surface: 'artifact_commit',
      reasonCode: 'artifact_commit_failed',
      message: 'generated video could not be committed as a thread artifact',
      cause: error,
    });
  }

  return {
    artifactVersion: {
      ...committed.version,
      title: committed.artifact.title ?? null,
      persistenceEpoch: committed.artifact.persistenceEpoch,
      sourceRef: committed.artifact.sourceRef ?? null,
    },
    provenance,
    media: {
      mimeType: downloaded.mimeType,
      byteLength: downloaded.written.byteLength,
      digestSha256: downloaded.written.sha256,
      mediaRef: downloaded.written.mediaRef,
      durationSeconds: generated.durationSeconds,
    },
  };
}
