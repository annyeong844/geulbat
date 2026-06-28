import { z } from 'zod';
import { readToolOutputSnapshot } from '../../files/tool-output-store.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const readToolOutputArgsSchema = z.strictObject({
  outputRef: z
    .string()
    .min(1, 'outputRef is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'outputRef is required.',
    })
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
    .optional()
    .describe(
      'Optional character count to read. Omit it to read the rest of the snapshot.',
    ),
});

export const readToolOutputTool = defineZodTool({
  name: 'read_tool_output',
  description:
    'Read all or an explicit page of a previously offloaded tool output snapshot by opaque outputRef.',
  argsSchema: readToolOutputArgsSchema,
  sideEffectLevel: 'read',
  mayMutateWorkspaceFiles: false,
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
    const startOffset = Math.min(offset, totalChars);
    const endOffset =
      args.limit === undefined
        ? totalChars
        : Math.min(startOffset + args.limit, totalChars);
    const hasMore = endOffset < totalChars;

    return {
      ok: true,
      output: JSON.stringify({
        ok: true,
        outputRef: snapshot.outputRef,
        toolName: snapshot.toolName,
        contentType: snapshot.contentType,
        offset: startOffset,
        limit: args.limit ?? null,
        endOffset,
        totalChars,
        hasMore,
        nextOffset: hasMore ? endOffset : null,
        content: snapshot.output.slice(startOffset, endOffset),
      }),
    };
  },
});
