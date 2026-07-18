import test from 'node:test';
import assert from 'node:assert/strict';

import type { ThreadId } from '@geulbat/protocol/ids';
import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import type { CommitThreadArtifactVersionArgs } from '../sessions/artifact-store.js';
import {
  ImageGenerationError,
  type GeneratedImageCandidate,
} from './contract.js';
import {
  createImageGenerationRuntime,
  type ImageGenerationRuntimeDeps,
} from './image-generation-runtime.js';

const THREAD_ID = 'thr_00000000000000000000000000' as ThreadId;

function buildCandidate(): GeneratedImageCandidate {
  return {
    asset: {
      mimeType: 'image/png',
      byteLength: 8,
      dataBase64: Buffer.from('png-body').toString('base64'),
      digest: { algorithm: 'sha256', encoding: 'hex', value: 'f'.repeat(64) },
    },
    provenance: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.4-mini',
      capability: 'image_generation',
      prompt: 'a cat',
      generatedAt: '2026-07-05T00:00:00.000Z',
    },
  };
}

interface CommitCall {
  workspaceRoot: string;
  renderer: string;
  payload: string;
  digest: string | null;
  title: string | null | undefined;
  workingDirectory: string | undefined;
}

function buildDeps(overrides: Partial<ImageGenerationRuntimeDeps>): {
  deps: ImageGenerationRuntimeDeps;
  commits: CommitCall[];
} {
  const commits: CommitCall[] = [];
  const deps: ImageGenerationRuntimeDeps = {
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerWebSocketSessions: {
      acquireWebSocket: () => {
        throw new Error('not used');
      },
    },
    getProviderAuthImpl: async () => ({
      accessToken: 'access-token',
      accountId: 'acct',
    }),
    forceRefreshProviderAuthImpl: async () => ({
      accessToken: 'refreshed-token',
      accountId: 'acct',
    }),
    generateViaCodexImpl: async () => buildCandidate(),
    // media 스토어 쓰기는 목킹 — 유닛 테스트는 커밋 오케스트레이션만 본다
    // (디스크 미접촉). 결정적 mediaRef를 돌려 thread_media 매니페스트를 만든다.
    writeThreadMediaFileImpl: async (args) => ({
      mediaRef: `${'a'.repeat(64)}.${args.extension}`,
      sha256: 'a'.repeat(64),
      byteLength: args.bytes.byteLength,
    }),
    commitThreadArtifactVersionImpl: async (
      args: CommitThreadArtifactVersionArgs,
    ) => {
      commits.push({
        workspaceRoot: args.workspaceRoot,
        renderer: args.renderer,
        payload: args.payload,
        digest: args.digest,
        title: args.title,
        workingDirectory: args.sourceRef?.workingDirectory,
      });
      return {
        artifact: {
          artifactId: 'art_1',
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
          artifactId: 'art_1',
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
        ref: { artifactId: 'art_1', version: 1 },
      };
    },
    now: () => '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
  return { deps, commits };
}

function baseInput() {
  return {
    request: { prompt: 'a cat' },
    stateRoot: '/tmp/home',
    workingDirectory: 'stories',
    threadId: THREAD_ID,
    runId: 'run-1',
  };
}

void test('generateImageArtifact validates, commits, and returns the committed version', async () => {
  const { deps, commits } = buildDeps({});
  const runtime = createImageGenerationRuntime(deps);

  const result = await runtime.generateImageArtifact(baseInput());

  assert.equal(commits.length, 1);
  const commit = commits[0];
  assert.ok(commit);
  assert.equal(commit.workspaceRoot, '/tmp/home');
  assert.equal(commit.renderer, 'image');
  assert.equal(commit.title, 'a cat');
  assert.ok(commit.payload.includes('generated_image'));
  // 매니페스트는 thread_media 참조만 담고 base64는 없다(D-V7 — 비대 해소)
  assert.ok(commit.payload.includes('thread_media'));
  assert.ok(!commit.payload.includes('dataBase64'));
  assert.equal(commit.workingDirectory, 'stories');

  assert.equal(result.artifactVersion.artifactId, 'art_1');
  assert.equal(result.artifactVersion.renderer, 'image');
  assert.equal(result.asset.mimeType, 'image/png');
  assert.equal(result.provenance.providerId, 'openai_codex_direct');
});

void test('generateImageArtifact fails closed as provider_not_connected without a refresh retry', async () => {
  let refreshCalls = 0;
  const { deps } = buildDeps({
    getProviderAuthImpl: async () => {
      throw new Error('Reconnect the provider');
    },
    forceRefreshProviderAuthImpl: async () => {
      refreshCalls += 1;
      throw new Error('should not be called');
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  await assert.rejects(
    () => runtime.generateImageArtifact(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.surface, 'provider_auth');
      assert.equal(error.reasonCode, 'provider_not_connected');
      // 사용자가 고른 프로바이더가 사용 불가 — 다른 프로바이더로 자동
      // 폴백하지 않고, 회복 불가능하므로 리프레시 재시도도 없다(§4.2)
      return true;
    },
  );
  assert.equal(refreshCalls, 0);
});

void test('generateImageArtifact wraps commit failures as artifact_commit_failed', async () => {
  const { deps } = buildDeps({
    commitThreadArtifactVersionImpl: async () => {
      throw new Error('disk full');
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  await assert.rejects(
    () => runtime.generateImageArtifact(baseInput()),
    (error: unknown) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.surface, 'artifact_commit');
      assert.equal(error.reasonCode, 'artifact_commit_failed');
      return true;
    },
  );
});

void test('generateImageArtifact passes the request-scope model through to the adapter', async () => {
  const seenModels: Array<string | undefined> = [];
  const { deps } = buildDeps({
    generateViaGrokImpl: async (input) => {
      seenModels.push(input.request.model);
      return buildCandidate();
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  await runtime.generateImageArtifact({
    ...baseInput(),
    providerId: 'grok_oauth',
    request: { prompt: 'a cat', model: 'grok-imagine-image-quality' },
  });
  assert.deepEqual(seenModels, ['grok-imagine-image-quality']);
});

void test('generateImageArtifact force-refreshes auth once and retries on auth failure', async () => {
  let attempts = 0;
  let refreshes = 0;
  const { deps } = buildDeps({
    generateViaCodexImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('auth failed'), {
          llmCode: 'llm_auth_failed',
        });
      }
      return buildCandidate();
    },
    forceRefreshProviderAuthImpl: async () => {
      refreshes += 1;
      return { accessToken: 'refreshed', accountId: 'acct' };
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  const result = await runtime.generateImageArtifact(baseInput());

  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
  assert.equal(result.artifactVersion.artifactId, 'art_1');
});

void test('generateImageArtifact does not retry provider_api failures', async () => {
  let attempts = 0;
  let refreshes = 0;
  const { deps, commits } = buildDeps({
    generateViaCodexImpl: async () => {
      attempts += 1;
      throw new Error('provider exploded');
    },
    forceRefreshProviderAuthImpl: async () => {
      refreshes += 1;
      return { accessToken: 'refreshed', accountId: 'acct' };
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  await assert.rejects(() => runtime.generateImageArtifact(baseInput()), {
    message: 'provider exploded',
  });
  assert.equal(attempts, 1);
  assert.equal(refreshes, 0);
  // 프로바이더 실패는 커밋 실패와 분리된다: 커밋 경로에 도달하지 않는다.
  assert.equal(commits.length, 0);
});

void test('generateImageArtifact routes grok provider selection to the grok adapter', async () => {
  let grokCalls = 0;
  const { deps } = buildDeps({
    generateViaGrokImpl: async () => {
      grokCalls += 1;
      return {
        ...buildCandidate(),
        provenance: {
          ...buildCandidate().provenance,
          providerId: 'grok_oauth',
          model: 'grok-2-image',
        },
      };
    },
  });
  const runtime = createImageGenerationRuntime(deps);

  const result = await runtime.generateImageArtifact({
    ...baseInput(),
    providerId: 'grok_oauth',
  });

  assert.equal(grokCalls, 1);
  assert.equal(result.provenance.providerId, 'grok_oauth');
});
