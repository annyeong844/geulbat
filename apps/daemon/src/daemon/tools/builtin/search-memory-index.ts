import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { searchMemoryIndex } from '../../memory/search-index.js';
import { defineZodTool } from '../zod-tool.js';

const searchMemoryIndexArgsSchema = z.strictObject({
  query: z
    .string()
    .min(1, 'query is required.')
    .describe(
      'Case-insensitive text query to search for within the memory index.',
    ),
  pathPrefix: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'pathPrefix must not be empty.',
    })
    .optional()
    .describe(
      'Optional normalized workspace-relative path prefix to constrain matches.',
    ),
  maxResults: z
    .number()
    .int('maxResults must be a positive integer.')
    .min(1, 'maxResults must be a positive integer.')
    .optional()
    .describe(
      'Optional maximum number of results to return. Omit it to return every match.',
    ),
});

export const searchMemoryIndexTool = defineZodTool({
  name: 'search_memory_index',
  description:
    'Search the derived memory index with a text query and return a structured shortlist. Results are hints only and not an authoritative source read.',
  argsSchema: searchMemoryIndexArgsSchema,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    if (!ctx.memoryIndex) {
      return toolError('execution_failed', 'memory index store is required');
    }
    try {
      const payload = await searchMemoryIndex(
        ctx.workspaceRoot,
        {
          query: args.query,
          ...(args.pathPrefix !== undefined
            ? { pathPrefix: args.pathPrefix }
            : {}),
          ...(args.maxResults !== undefined
            ? { maxResults: args.maxResults }
            : {}),
        },
        {
          memoryIndex: ctx.memoryIndex,
        },
      );
      return { ok: true, output: JSON.stringify(payload) };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
