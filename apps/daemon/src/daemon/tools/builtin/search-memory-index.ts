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
    .optional()
    .describe(
      'Optional normalized workspace-relative path prefix to constrain matches.',
    ),
  maxResults: z
    .number()
    .optional()
    .describe(
      'Maximum number of results to return. Defaults to 10, capped at 50.',
    ),
});

export const searchMemoryIndexTool = defineZodTool({
  name: 'search_memory_index',
  description:
    'Search the derived memory index with a text query and return a structured shortlist. Results are hints only and not an authoritative source read.',
  argsSchema: searchMemoryIndexArgsSchema,
  sideEffectLevel: 'none',
  timeoutMs: 30_000,
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
