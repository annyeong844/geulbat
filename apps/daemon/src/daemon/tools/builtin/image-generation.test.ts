import test from 'node:test';
import assert from 'node:assert/strict';

import { createDaemonContext } from '../../context.js';
import type { AgentEvent } from '../../agent/events.js';
import type {
  GenerateImageArtifactInput,
  GenerateImageArtifactResult,
  ImageGenerationRuntime,
} from '../../media/contract.js';
import { ImageGenerationError } from '../../media/contract.js';
import { isToolObjectParameters } from '../types.js';
import { generateImageTool } from './image-generation.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const threadId = testThreadId(4301);

function buildResult(): GenerateImageArtifactResult {
  return {
    artifactVersion: {
      artifactId: 'art_img',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'image',
      payload: '{"schemaVersion":1}',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-07-05T00:00:00.000Z',
      createdByRunId: 'run-1',
      previewValidation: { ok: true },
      title: '고양이',
      persistenceEpoch: 0,
      sourceRef: null,
    },
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-2-image',
      capability: 'image_generation',
      prompt: '고양이',
      generatedAt: '2026-07-05T00:00:00.000Z',
    },
    asset: {
      mimeType: 'image/png',
      byteLength: 1234,
      digest: { algorithm: 'sha256', encoding: 'hex', value: 'ab'.repeat(32) },
    },
  };
}

function buildAgentContext(args: {
  imageGeneration: ImageGenerationRuntime;
  events: AgentEvent[];
}) {
  const daemonContext = createDaemonContext();
  return {
    kind: 'agent' as const,
    runOwnerKind: 'root_main' as const,
    callId: 'call-image-1',
    stateRoot: daemonContext.homeStateRoot,
    workingDirectory: 'stories',
    threadId,
    runId: 'run-image-1',
    runState: undefined,
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: false,
    agentSpawnRuntime: {
      ...daemonContext,
      imageGeneration: args.imageGeneration,
    },
    memoryIndex: undefined,
    emitAgentEvent: (event: AgentEvent) => {
      args.events.push(event);
    },
    permissionMode: 'full_access' as const,
    approvalSessionId: 'approval-session',
  };
}

void test('generate_image exposes prompt-first schema and no-approval write metadata', () => {
  assert.equal(generateImageTool.name, 'generate_image');
  assert.equal(generateImageTool.sideEffectLevel, 'write');
  assert.equal(generateImageTool.mayMutateComputerFiles, false);
  assert.equal(generateImageTool.requiresApproval, false);
  const parameters = generateImageTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['prompt']);
  assert.ok('provider' in parameters.properties);
  assert.ok('size' in parameters.properties);
  assert.ok('quality' in parameters.properties);
});

void test('generate_image commits via the runtime, emits artifact_committed, and returns reference metadata only', async () => {
  const events: AgentEvent[] = [];
  const seenInputs: GenerateImageArtifactInput[] = [];
  const ctx = buildAgentContext({
    events,
    imageGeneration: {
      generateImageArtifact: async (input) => {
        seenInputs.push(input);
        return buildResult();
      },
      withRequestDefaults() {
        throw new Error('not used in this test');
      },
    },
  });

  const parsed = generateImageTool.parseArgs({
    prompt: '고양이',
    provider: 'grok_oauth',
  });
  assert.ok(parsed.ok);
  const result = await generateImageTool.executeParsed(parsed.value, ctx);

  assert.equal(result.ok, true);
  assert.equal(seenInputs.length, 1);
  assert.equal(seenInputs[0]?.providerId, 'grok_oauth');
  assert.equal(seenInputs[0]?.request.prompt, '고양이');

  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event && event.type === 'artifact_committed');
  assert.equal(event.payload.artifactId, 'art_img');

  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.ok, true);
  assert.equal(output.artifactRef, 'art_img@1');
  assert.equal(output.provider, 'grok_oauth');
  // 바이트/base64는 모델에게 돌려주지 않는다.
  assert.ok(!result.output.includes('dataBase64'));
});

void test('generate_image maps the failure taxonomy to distinct error codes', async () => {
  const cases = [
    {
      surface: 'provider_auth' as const,
      reasonCode: 'provider_not_connected',
      expected: 'image_provider_unavailable',
    },
    {
      surface: 'artifact_commit' as const,
      reasonCode: 'artifact_commit_failed',
      expected: 'artifact_commit_failed',
    },
    {
      surface: 'candidate_validation' as const,
      reasonCode: 'image_too_large',
      expected: 'invalid_image_response',
    },
    {
      surface: 'provider_api' as const,
      reasonCode: 'empty_image_result',
      expected: 'invalid_image_response',
    },
    {
      surface: 'provider_api' as const,
      reasonCode: 'provider_rate_limited',
      expected: 'llm_rate_limited',
    },
    {
      surface: 'provider_api' as const,
      reasonCode: 'provider_quota_exceeded',
      expected: 'quota_exceeded',
    },
  ];

  for (const { surface, reasonCode, expected } of cases) {
    const ctx = buildAgentContext({
      events: [],
      imageGeneration: {
        generateImageArtifact: async () => {
          throw new ImageGenerationError({
            surface,
            reasonCode,
            message: `curated ${reasonCode} message`,
          });
        },
        withRequestDefaults() {
          throw new Error('not used in this test');
        },
      },
    });
    const parsed = generateImageTool.parseArgs({ prompt: 'p' });
    assert.ok(parsed.ok);
    const result = await generateImageTool.executeParsed(parsed.value, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, expected);
    // 분류된 메시지가 surface/reasonCode와 함께 남는다(§4.4)
    assert.ok(result.error?.includes(reasonCode));
  }
});

void test('generate_image maps provider auth failures to llm_auth_failed', async () => {
  const events: AgentEvent[] = [];
  const ctx = buildAgentContext({
    events,
    imageGeneration: {
      generateImageArtifact: async () => {
        throw new ImageGenerationError({
          surface: 'provider_auth',
          reasonCode: 'provider_auth_rejected',
          message: 'reconnect required',
        });
      },
      withRequestDefaults() {
        throw new Error('not used in this test');
      },
    },
  });

  const parsed = generateImageTool.parseArgs({ prompt: 'p' });
  assert.ok(parsed.ok);
  const result = await generateImageTool.executeParsed(parsed.value, ctx);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'llm_auth_failed');
  assert.deepEqual(events, []);
});
