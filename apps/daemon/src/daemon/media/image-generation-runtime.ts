import { rm } from 'node:fs/promises';

import { forceRefreshProviderAuth, getProviderAuth } from '../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import type { ResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
import { commitThreadArtifactVersion } from '../sessions/artifact-store.js';
import {
  resolveThreadMediaFilePath,
  writeThreadMediaFile,
  type ThreadMediaExtension,
} from '../sessions/media-file-store.js';
import {
  ImageGenerationError,
  isImageGenerationProviderId,
  type GenerateImageArtifactInput,
  type GenerateImageArtifactResult,
  type GeneratedImageCandidate,
  type GeneratedImageMimeType,
  type ImageGenerationProviderId,
  type ImageGenerationRuntime,
} from './contract.js';
import {
  acquireGenerationProviderAuthOrFailClosed,
  generateWithProviderAuthRetry,
} from './generation-provider-auth.js';
import { buildImageArtifactCandidate } from './image-artifact-candidate.js';
import { withImageGenerationRequestDefaults } from './image-generation-request-defaults.js';
import { generateImageViaCodexResponses } from './providers/codex-image-provider.js';
import { generateImageViaGrok } from './providers/grok-image-provider.js';

// 이미지 생성의 데몬-프라이빗 진입점. provider-auth를 유일한 인증 소유자로
// 재사용하고(사이드 OAuth 금지), 프로바이더 어댑터에는 호출 시점 최소 인증
// 재료만 전달한다. 401류 실패는 한 번의 강제 리프레시 후 재시도하고,
// 검증을 통과한 후보만 아티팩트 커밋 경로로 넘긴다.

export interface ImageGenerationRuntimeDeps {
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket'
  >;
  getProviderAuthImpl?: typeof getProviderAuth;
  forceRefreshProviderAuthImpl?: typeof forceRefreshProviderAuth;
  generateViaCodexImpl?: typeof generateImageViaCodexResponses;
  generateViaGrokImpl?: typeof generateImageViaGrok;
  commitThreadArtifactVersionImpl?: typeof commitThreadArtifactVersion;
  writeThreadMediaFileImpl?: typeof writeThreadMediaFile;
  now?: () => string;
}

// 생성 이미지 크기 상한(media 스토어 쓰기 belt-and-suspenders) — 후보 검증이
// 이미 32MB 정책을 강제하므로 넉넉히. env knob은 동영상과 별도.
const DEFAULT_IMAGE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

function resolveImageMediaMaxBytes(): number {
  const raw = process.env.GEULBAT_IMAGE_GENERATION_MAX_BYTES;
  if (raw === undefined) {
    return DEFAULT_IMAGE_MEDIA_MAX_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_IMAGE_MEDIA_MAX_BYTES;
}

// GeneratedImageMimeType는 폐쇄 집합이라 exhaustive 매핑이 가능하다.
const IMAGE_MIME_TO_EXTENSION: Record<
  GeneratedImageMimeType,
  ThreadMediaExtension
> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const DEFAULT_IMAGE_GENERATION_PROVIDER: ImageGenerationProviderId =
  'openai_codex_direct';

function resolveDefaultImageGenerationProvider(): ImageGenerationProviderId {
  const raw = process.env.GEULBAT_IMAGE_GENERATION_DEFAULT_PROVIDER;
  return isImageGenerationProviderId(raw)
    ? raw
    : DEFAULT_IMAGE_GENERATION_PROVIDER;
}

const IMAGE_ARTIFACT_TITLE_MAX_LENGTH = 80;

function buildImageArtifactTitle(prompt: string): string {
  const singleLine = prompt.replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= IMAGE_ARTIFACT_TITLE_MAX_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, IMAGE_ARTIFACT_TITLE_MAX_LENGTH - 1)}…`;
}

export function createImageGenerationRuntime(
  deps: ImageGenerationRuntimeDeps,
): ImageGenerationRuntime {
  const runtime: ImageGenerationRuntime = {
    async generateImageArtifact(
      input: GenerateImageArtifactInput,
    ): Promise<GenerateImageArtifactResult> {
      const providerId =
        input.providerId ?? resolveDefaultImageGenerationProvider();
      const candidate = await generateWithProviderAuthRetry({
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        runAttempt: (options) =>
          generateImageOnce(input, deps, providerId, options),
        forceRefresh: () => forceRefreshSelectedProviderAuth(deps, providerId),
      });
      return commitGeneratedImageCandidate(input, deps, candidate);
    },
    withRequestDefaults(defaults) {
      return withImageGenerationRequestDefaults(runtime, defaults);
    },
  };
  return runtime;
}

async function generateImageOnce(
  input: GenerateImageArtifactInput,
  deps: ImageGenerationRuntimeDeps,
  providerId: ImageGenerationProviderId,
  options: { allowRefresh: boolean },
): Promise<GeneratedImageCandidate> {
  const getAuth = deps.getProviderAuthImpl ?? getProviderAuth;

  if (providerId === 'grok_oauth') {
    const auth = await acquireGenerationProviderAuthOrFailClosed({
      mediaKind: 'image',
      providerId: 'grok_oauth',
      acquire: () =>
        getAuth({
          providerId: 'grok_oauth',
          allowRefresh: options.allowRefresh,
          runtimeStore: deps.providerAuthRuntime,
        }),
    });
    const generate = deps.generateViaGrokImpl ?? generateImageViaGrok;
    return generate({
      request: input.request,
      auth: { accessToken: auth.accessToken },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  }

  const auth = await acquireGenerationProviderAuthOrFailClosed({
    mediaKind: 'image',
    providerId: 'openai_codex_direct',
    acquire: () =>
      getAuth({
        providerId: 'openai_codex_direct',
        allowRefresh: options.allowRefresh,
        runtimeStore: deps.providerAuthRuntime,
      }),
  });
  const generate = deps.generateViaCodexImpl ?? generateImageViaCodexResponses;
  return generate({
    request: input.request,
    auth: { accessToken: auth.accessToken, accountId: auth.accountId },
    // 스레드 단위로 소켓을 재사용하되 채팅 세션과는 분리한다.
    providerSessionId: `image-generation:${input.threadId}`,
    providerWebSocketSessions: deps.providerWebSocketSessions,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

// 프로바이더 성공 ≠ durable — 커밋 실패를 별도 표면으로 분류해 사용자에게
// "생성은 됐는데 저장이 실패"를 구분해 보여줄 수 있게 한다(§4.4).
async function commitOrFailClosed<T>(commit: () => Promise<T>): Promise<T> {
  try {
    return await commit();
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'artifact_commit',
      reasonCode: 'artifact_commit_failed',
      message: 'generated image could not be committed as a thread artifact',
      cause: error,
    });
  }
}

// media 파일 정리는 **절대 원래 오류를 가리지 않는다** — 경로 해석/삭제가
// 실패해도 삼키고 커밋 실패를 그대로 전파한다(방어적 cleanup).
async function removeWrittenImageMediaFile(
  input: GenerateImageArtifactInput,
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
    // cleanup 실패는 무시한다(원래 커밋 오류 우선).
  }
}

async function commitGeneratedImageCandidate(
  input: GenerateImageArtifactInput,
  deps: ImageGenerationRuntimeDeps,
  candidate: GeneratedImageCandidate,
): Promise<GenerateImageArtifactResult> {
  // 바이트를 media 파일 스토어에 먼저 쓴다(D-V7) — 매니페스트에는 mediaRef
  // 파일명만 남고 base64는 스냅샷/와이어에 실리지 않는다. 커밋 실패 시
  // 방금 쓴 파일을 정리해 고아를 남기지 않는다(동영상과 동일 규범).
  const write = deps.writeThreadMediaFileImpl ?? writeThreadMediaFile;
  const written = await commitOrFailClosed(() =>
    write({
      workspaceRoot: input.stateRoot,
      threadId: input.threadId,
      extension: IMAGE_MIME_TO_EXTENSION[candidate.asset.mimeType],
      bytes: Buffer.from(candidate.asset.dataBase64, 'base64'),
      maxBytes: resolveImageMediaMaxBytes(),
    }),
  );

  const artifactCandidate = buildImageArtifactCandidate({
    candidate,
    mediaRef: written.mediaRef,
  });
  const commit =
    deps.commitThreadArtifactVersionImpl ?? commitThreadArtifactVersion;
  const now = deps.now ?? (() => new Date().toISOString());
  const timestamp = now();
  let committed: Awaited<ReturnType<typeof commitThreadArtifactVersion>>;
  try {
    committed = await commit({
      workspaceRoot: input.stateRoot,
      threadId: input.threadId,
      runId: input.runId,
      renderer: artifactCandidate.renderer,
      payload: artifactCandidate.payload,
      digest: artifactCandidate.digest,
      title: buildImageArtifactTitle(candidate.provenance.prompt),
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
    await removeWrittenImageMediaFile(input, written.mediaRef);
    throw new ImageGenerationError({
      surface: 'artifact_commit',
      reasonCode: 'artifact_commit_failed',
      message: 'generated image could not be committed as a thread artifact',
      cause: error,
    });
  }

  const mediaFilePath = resolveThreadMediaFilePath({
    workspaceRoot: input.stateRoot,
    threadId: input.threadId,
    mediaRef: written.mediaRef,
  });

  return {
    artifactVersion: {
      ...committed.version,
      title: committed.artifact.title ?? null,
      persistenceEpoch: committed.artifact.persistenceEpoch,
      sourceRef: committed.artifact.sourceRef ?? null,
    },
    provenance: candidate.provenance,
    asset: {
      mimeType: candidate.asset.mimeType,
      byteLength: candidate.asset.byteLength,
      digest: candidate.asset.digest,
    },
    media:
      mediaFilePath === null
        ? null
        : { mediaRef: written.mediaRef, filePath: mediaFilePath },
  };
}

async function forceRefreshSelectedProviderAuth(
  deps: ImageGenerationRuntimeDeps,
  providerId: ImageGenerationProviderId,
): Promise<void> {
  const forceRefresh =
    deps.forceRefreshProviderAuthImpl ?? forceRefreshProviderAuth;
  if (providerId === 'grok_oauth') {
    await forceRefresh({
      providerId: 'grok_oauth',
      runtimeStore: deps.providerAuthRuntime,
    });
    return;
  }
  await forceRefresh({
    providerId: 'openai_codex_direct',
    runtimeStore: deps.providerAuthRuntime,
  });
}
