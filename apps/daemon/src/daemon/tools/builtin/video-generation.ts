import { z } from 'zod';
import { getErrorMessage } from '../../utils/error.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  stringifyGenerateVideoFailure,
  stringifyGenerateVideoOutput,
  videoGenerationFailureToolErrorCode,
} from './video-generation-result.js';

// 동영상 생성은 비동기 잡 폴링(기본 상한 10분) + 다운로드가 걸린다.
// 툴 타임아웃은 폴링 상한과 정렬해 그보다 넉넉하게 잡는다(§4.5).
const DEFAULT_GENERATE_VIDEO_TIMEOUT_MS = 720_000;

function resolveGenerateVideoTimeoutMs(): number {
  const raw = process.env.GEULBAT_VIDEO_GENERATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_GENERATE_VIDEO_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GENERATE_VIDEO_TIMEOUT_MS;
}

const generateVideoArgsSchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required.')
    .describe(
      "Video description. Pass the user's wording through as faithfully as possible; do not translate or restyle it yourself.",
    ),
  sourceArtifactRef: z
    .string()
    .optional()
    .describe(
      'Animate an existing image artifact from THIS thread: pass its ref like "art_...@1" (from a previous generate_image result). Omit to create the video from the text prompt alone.',
    ),
  durationSeconds: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe(
      'Video length in seconds (1-15). Only pass this when the user explicitly asked for a specific length in the current turn; omit otherwise.',
    ),
});

type GenerateVideoArgs = z.output<typeof generateVideoArgsSchema>;

export const generateVideoTool = defineZodTool({
  name: 'generate_video',
  description:
    'Generate one short video from a text prompt (or animate an existing image artifact from this thread) and commit it as a thread artifact the user can play inline. Returns reference metadata only (no video bytes).',
  argsSchema: generateVideoArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  timeoutMs: resolveGenerateVideoTimeoutMs(),
  catalogSearchMetadata: {
    family: 'network',
    searchHints: [
      'generate video',
      'animate image',
      'make a clip',
      'video generation',
      '동영상 생성',
      '영상 만들어줘',
      '움직여줘',
    ],
    tags: ['media', 'video', 'generation', 'artifact'],
    whenToUse:
      'Create a short video from a text description, or animate an image artifact that was generated earlier in this thread.',
    notFor:
      'Editing existing videos, reading or analyzing media files, or fetching videos from the web.',
  },
  async executeParsed(args: GenerateVideoArgs, ctx) {
    if (
      !ctx.threadId ||
      !ctx.stateRoot ||
      ctx.workingDirectory === undefined ||
      !ctx.runId
    ) {
      return toolError(
        'execution_failed',
        'run context is required for generate_video.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.videoGeneration;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'video generation runtime is required.',
      );
    }

    try {
      const result = await runtime.generateVideoArtifact({
        request: {
          prompt: args.prompt,
          ...(args.durationSeconds !== undefined
            ? { durationSeconds: args.durationSeconds }
            : {}),
        },
        ...(args.sourceArtifactRef !== undefined
          ? { sourceArtifactRef: args.sourceArtifactRef }
          : {}),
        stateRoot: ctx.stateRoot,
        workingDirectory: ctx.workingDirectory,
        threadId: ctx.threadId,
        runId: ctx.runId,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });

      // 커밋된 아티팩트를 즉시 셸에 알린다(라이브 표시) — 이미지와 동일 경로
      ctx.emitAgentEvent?.({
        type: 'artifact_committed',
        payload: result.artifactVersion,
      });

      return {
        ok: true,
        output: stringifyGenerateVideoOutput(result),
      };
    } catch (error: unknown) {
      const failure = stringifyGenerateVideoFailure(
        error,
        getErrorMessage(error),
      );
      return {
        ok: false,
        output: failure.output,
        errorCode: videoGenerationFailureToolErrorCode(error),
        error: failure.message,
      };
    }
  },
});
