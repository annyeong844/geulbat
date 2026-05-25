import { z } from 'zod';
import { readToolOutputSnapshot } from '../../files/tool-output-store.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const DEFAULT_READ_TOOL_OUTPUT_LIMIT_CHARS = 4_096;
const MAX_READ_TOOL_OUTPUT_LIMIT_CHARS = 20_000;

const readToolOutputArgsSchema = z.strictObject({
  outputRef: z
    .string()
    .min(1, 'outputRef is required.')
    .describe('Opaque tool output reference returned by a previous tool call.'),
  offset: z
    .number()
    .int('offset must be an integer.')
    .min(0, 'offset must be non-negative.')
    .optional()
    .describe('Character offset to start reading from. Defaults to 0.'),
  limit: z
    .number()
    .int('limit must be an integer.')
    .min(1, 'limit must be positive.')
    .max(
      MAX_READ_TOOL_OUTPUT_LIMIT_CHARS,
      `limit is too large (max ${MAX_READ_TOOL_OUTPUT_LIMIT_CHARS} characters).`,
    )
    .optional()
    .describe(
      `Maximum characters to read. Defaults to ${DEFAULT_READ_TOOL_OUTPUT_LIMIT_CHARS}.`,
    ),
});

export const readToolOutputTool = defineZodTool({
  name: 'read_tool_output',
  description:
    'Read a paged slice of a previously offloaded tool output snapshot by opaque outputRef.',
  argsSchema: readToolOutputArgsSchema,
  sideEffectLevel: 'read',
  timeoutMs: 5_000,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    if (!ctx.threadId) {
      return toolError(
        'invalid_args',
        'read_tool_output requires an agent thread context.',
      );
    }

    const snapshotResult = await readToolOutputSnapshot({
      workspaceRoot: ctx.workspaceRoot,
      threadId: ctx.threadId,
      outputRef: args.outputRef,
    });
    if (!snapshotResult.ok) {
      return toolError(snapshotResult.errorCode, snapshotResult.message);
    }

    const snapshot = snapshotResult.value;
    const totalChars = snapshot.output.length;
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_READ_TOOL_OUTPUT_LIMIT_CHARS;
    const startOffset = Math.min(offset, totalChars);
    const endOffset = Math.min(startOffset + limit, totalChars);

    return {
      ok: true,
      output: JSON.stringify({
        ok: true,
        outputRef: snapshot.outputRef,
        toolName: snapshot.toolName,
        contentType: snapshot.contentType,
        offset: startOffset,
        limit,
        endOffset,
        totalChars,
        truncated: endOffset < totalChars,
        content: snapshot.output.slice(startOffset, endOffset),
      }),
    };
  },
});
