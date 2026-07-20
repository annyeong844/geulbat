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
    .describe('Required character count for this bounded output page.'),
});

export const readToolOutputTool = defineZodTool({
  name: 'read_tool_output',
  description:
    'Read one explicit bounded page of a previously offloaded tool output snapshot by opaque outputRef. Pass the required limit and an optional offset; continue from nextOffset only when more content is needed.',
  argsSchema: readToolOutputArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  exposure: {
    directHot: true,
    sdkVisible: true,
    inCellCallable: true,
    directOnly: false,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'tool_output',
    searchHints: ['large output', 'read output ref', 'recover output'],
    tags: ['tool-output', 'offload', 'recovery'],
    whenToUse: 'Page through a previously offloaded tool output snapshot.',
    notFor: 'Reading arbitrary Computer files or raw .geulbat paths.',
  },
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'invalid_args',
        'read_tool_output requires an agent thread context.',
      );
    }

    const snapshotResult = await readToolOutputSnapshot({
      stateRoot: ctx.stateRoot,
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
    const endOffset = Math.min(startOffset + args.limit, totalChars);
    const hasMore = endOffset < totalChars;

    return {
      ok: true,
      output: JSON.stringify({
        ok: true,
        outputRef: snapshot.outputRef,
        toolName: snapshot.toolName,
        contentType: snapshot.contentType,
        offset: startOffset,
        limit: args.limit,
        endOffset,
        totalChars,
        hasMore,
        nextOffset: hasMore ? endOffset : null,
        content: snapshot.output.slice(startOffset, endOffset),
      }),
    };
  },
});
