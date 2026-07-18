import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { resolveMemoryIndexScope } from '../../memory/build-index.js';
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
      'Optional path prefix relative to the indexed working directory.',
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
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  exposure: {
    directHot: false,
    sdkVisible: true,
    inCellCallable: true,
    directOnly: false,
    approvalRequired: false,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'memory',
    searchHints: [
      'search memory',
      'memory search',
      'find memory',
      'look up previous context',
    ],
    tags: ['memory', 'index', 'search'],
    whenToUse: 'Search indexed long-range memory or prior context hints.',
    notFor: 'Reading current Computer files before mutation.',
  },
  async executeParsed(args, ctx) {
    if (!ctx.memoryIndex) {
      return toolError('execution_failed', 'memory index store is required');
    }
    try {
      const scope = resolveMemoryIndexScope({
        ...(ctx.stateRoot === undefined ? {} : { stateRoot: ctx.stateRoot }),
        ...(ctx.computerFileRoot === undefined
          ? {}
          : { computerFileRoot: ctx.computerFileRoot }),
        ...(ctx.workingDirectory === undefined
          ? {}
          : { workingDirectory: ctx.workingDirectory }),
      });
      const payload = await searchMemoryIndex(
        scope,
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
