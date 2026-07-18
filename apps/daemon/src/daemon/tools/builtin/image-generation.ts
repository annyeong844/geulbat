import { z } from 'zod';
import {
  IMAGE_GENERATION_PROVIDER_IDS,
  IMAGE_GENERATION_QUALITIES,
  IMAGE_GENERATION_SIZES,
} from '../../media/contract.js';
import { getErrorMessage } from '../../utils/error.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  imageGenerationFailureToolErrorCode,
  stringifyGenerateImageFailure,
  stringifyGenerateImageOutput,
} from './image-generation-result.js';

// 이미지 생성은 프로바이더에 따라 수십 초 걸린다. 기본 5분, env로 조절.
const DEFAULT_GENERATE_IMAGE_TIMEOUT_MS = 300_000;

function resolveGenerateImageTimeoutMs(): number {
  const raw = process.env.GEULBAT_IMAGE_GENERATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_GENERATE_IMAGE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GENERATE_IMAGE_TIMEOUT_MS;
}

const generateImageArgsSchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required.')
    .describe(
      "Image description. Pass the user's wording through as faithfully as possible; do not translate or restyle it yourself.",
    ),
  provider: z
    .enum(IMAGE_GENERATION_PROVIDER_IDS)
    .optional()
    .describe(
      'Image provider. Omit to use the configured default. Requires that provider to be connected in provider auth.',
    ),
  size: z
    .enum(IMAGE_GENERATION_SIZES)
    .optional()
    .describe(
      'Requested output size. Only some providers honor this; omit for the provider default.',
    ),
  quality: z
    .enum(IMAGE_GENERATION_QUALITIES)
    .optional()
    .describe(
      'Requested quality tier. Only some providers honor this; omit for the provider default.',
    ),
});

type GenerateImageArgs = z.output<typeof generateImageArgsSchema>;

export const generateImageTool = defineZodTool({
  name: 'generate_image',
  description:
    'Generate one image from a text prompt using the connected image provider and commit it as a thread artifact the user can see. Returns reference metadata only (no image bytes).',
  argsSchema: generateImageArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  timeoutMs: resolveGenerateImageTimeoutMs(),
  catalogSearchMetadata: {
    family: 'network',
    searchHints: [
      'generate image',
      'draw picture',
      'create illustration',
      'image generation',
      '이미지 생성',
      '그림 그려줘',
    ],
    tags: ['media', 'image', 'generation', 'artifact'],
    whenToUse:
      'Create a new image from a text description and show it to the user.',
    notFor:
      'Reading or analyzing existing images, editing uploaded files, or fetching images from the web.',
  },
  async executeParsed(args: GenerateImageArgs, ctx) {
    if (
      !ctx.threadId ||
      !ctx.stateRoot ||
      ctx.workingDirectory === undefined ||
      !ctx.runId
    ) {
      return toolError(
        'execution_failed',
        'run context is required for generate_image.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.imageGeneration;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'image generation runtime is required.',
      );
    }

    try {
      const result = await runtime.generateImageArtifact({
        request: {
          prompt: args.prompt,
          ...(args.size !== undefined ? { size: args.size } : {}),
          ...(args.quality !== undefined ? { quality: args.quality } : {}),
        },
        ...(args.provider !== undefined ? { providerId: args.provider } : {}),
        stateRoot: ctx.stateRoot,
        workingDirectory: ctx.workingDirectory,
        threadId: ctx.threadId,
        runId: ctx.runId,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });

      // 커밋된 아티팩트를 즉시 셸에 알린다(라이브 표시). 재로드 지속성은
      // 어시스턴트 메시지 메타데이터 바인딩(포그라운드 퍼시스턴스)이 맡는다.
      ctx.emitAgentEvent?.({
        type: 'artifact_committed',
        payload: result.artifactVersion,
      });

      return {
        ok: true,
        output: stringifyGenerateImageOutput(result),
      };
    } catch (error: unknown) {
      const failure = stringifyGenerateImageFailure(
        error,
        getErrorMessage(error),
      );
      return {
        ok: false,
        output: failure.output,
        errorCode: imageGenerationFailureToolErrorCode(error),
        error: failure.message,
      };
    }
  },
});
