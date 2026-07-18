import assert from 'node:assert/strict';
import test from 'node:test';

import { createDaemonContext } from '../../context.js';
import type { AgentEvent } from '../../agent/events.js';
import type {
  GenerateVideoArtifactResult,
  VideoGenerationRuntime,
} from '../../media/contract.js';
import { ImageGenerationError } from '../../media/contract.js';
import { isToolObjectParameters } from '../types.js';
import { generateVideoTool } from './video-generation.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const threadId = testThreadId(4401);

function buildResult(): GenerateVideoArtifactResult {
  return {
    artifactVersion: {
      artifactId: 'art_vid',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'video',
      payload: '{"schemaVersion":1}',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-07-13T00:00:00.000Z',
      createdByRunId: 'run-1',
      previewValidation: { ok: true },
      title: '고양이 동영상',
      persistenceEpoch: 0,
      sourceRef: null,
    },
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-imagine-video-1.5',
      capability: 'video_generation',
      prompt: '고양이',
      sourceImage: 'blank_canvas',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
    media: {
      mimeType: 'video/mp4',
      byteLength: 843620,
      digestSha256: 'ab'.repeat(32),
      mediaRef: `${'ab'.repeat(32)}.mp4`,
      durationSeconds: 5,
    },
  };
}

function buildAgentContext(args: {
  videoGeneration: VideoGenerationRuntime;
  events: AgentEvent[];
}) {
  const daemonContext = createDaemonContext();
  return {
    kind: 'agent' as const,
    runOwnerKind: 'root_main' as const,
    callId: 'call-video-1',
    stateRoot: daemonContext.homeStateRoot,
    workingDirectory: 'stories',
    threadId,
    runId: 'run-video-1',
    runState: undefined,
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: false,
    agentSpawnRuntime: {
      ...daemonContext,
      videoGeneration: args.videoGeneration,
    },
    memoryIndex: undefined,
    emitAgentEvent: (event: AgentEvent) => {
      args.events.push(event);
    },
    permissionMode: 'full_access' as const,
    approvalSessionId: 'approval-session',
  };
}

void test('generate_video exposes prompt-first schema and no-approval write metadata', () => {
  assert.equal(generateVideoTool.name, 'generate_video');
  assert.equal(generateVideoTool.sideEffectLevel, 'write');
  assert.equal(generateVideoTool.mayMutateComputerFiles, false);
  assert.equal(generateVideoTool.requiresApproval, false);
  const parameters = generateVideoTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['prompt']);
  assert.ok('sourceArtifactRef' in parameters.properties);
  assert.ok('durationSeconds' in parameters.properties);
});

void test('generate_video commits via the runtime, emits artifact_committed, and returns reference metadata only', async () => {
  const events: AgentEvent[] = [];
  const calls: unknown[] = [];
  const runtime: VideoGenerationRuntime = {
    generateVideoArtifact: async (input) => {
      calls.push(input);
      return buildResult();
    },
    withRequestDefaults() {
      return runtime;
    },
  };

  const result = await generateVideoTool.execute(
    {
      prompt: '수채화 고양이가 손을 흔드는 동영상',
      sourceArtifactRef: 'art_img@1',
      durationSeconds: 7,
    },
    buildAgentContext({ videoGeneration: runtime, events }),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const input = calls[0] as {
    request: { prompt: string; durationSeconds?: number };
    sourceArtifactRef?: string;
  };
  assert.equal(input.request.durationSeconds, 7);
  assert.equal(input.sourceArtifactRef, 'art_img@1');

  // 라이브 표시 이벤트가 방출된다(이미지와 동일 경로)
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'artifact_committed');

  // 출력은 참조 메타데이터만 — 바이트/base64 미포함
  const output = JSON.parse(String(result.output));
  assert.equal(output.artifactRef, 'art_vid@1');
  assert.equal(output.durationSeconds, 5);
  assert.equal(output.provider, 'grok_oauth');
  assert.equal(output.sourceImage, 'blank_canvas');
  assert.ok(!String(result.output).includes('base64'));
});

void test('generate_video maps the failure taxonomy to distinct error codes', async () => {
  async function failWith(error: unknown): Promise<{
    ok: boolean;
    errorCode?: string;
    error?: string;
  }> {
    const runtime: VideoGenerationRuntime = {
      generateVideoArtifact: async () => {
        throw error;
      },
      withRequestDefaults() {
        return runtime;
      },
    };
    return generateVideoTool.execute(
      { prompt: 'x' },
      buildAgentContext({ videoGeneration: runtime, events: [] }),
    ) as Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  }

  // 소스 아티팩트 가드 → invalid_args (모델이 넘긴 인자 문제)
  const sourceMissing = await failWith(
    new ImageGenerationError({
      surface: 'candidate_validation',
      reasonCode: 'source_artifact_not_found',
      message: 'not in this thread',
    }),
  );
  assert.equal(sourceMissing.errorCode, 'invalid_args');

  // 폴링 상한/잡 만료 → timeout
  const timedOut = await failWith(
    new ImageGenerationError({
      surface: 'provider_api',
      reasonCode: 'provider_request_timeout',
      message: 'ceiling',
    }),
  );
  assert.equal(timedOut.errorCode, 'timeout');

  // 미연결 → image_provider_unavailable (§4.2 fail-closed 승계)
  const notConnected = await failWith(
    new ImageGenerationError({
      surface: 'provider_auth',
      reasonCode: 'provider_not_connected',
      message: 'connect grok first',
    }),
  );
  assert.equal(notConnected.errorCode, 'image_provider_unavailable');

  // 커밋 실패 → artifact_commit_failed
  const commitFailed = await failWith(
    new ImageGenerationError({
      surface: 'artifact_commit',
      reasonCode: 'artifact_commit_failed',
      message: 'disk full',
    }),
  );
  assert.equal(commitFailed.errorCode, 'artifact_commit_failed');
});
