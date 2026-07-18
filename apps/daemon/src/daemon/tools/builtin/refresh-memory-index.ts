import { z } from 'zod';
import { resolveMemoryIndexScope } from '../../memory/build-index.js';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const refreshMemoryIndexArgsSchema = z.strictObject({});

export const refreshMemoryIndexTool = defineZodTool({
  name: 'refresh_memory_index',
  description:
    'Rebuild the derived memory index in private Home state from the current working directory. Does not modify Computer files.',
  argsSchema: refreshMemoryIndexArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: true,
  catalogSearchMetadata: {
    family: 'memory',
    searchHints: ['refresh memory', 'rebuild memory index', 'index memory'],
    tags: ['memory', 'index', 'refresh'],
    whenToUse: 'Refresh the memory index before memory search.',
    notFor: 'Searching or reading current Computer files directly.',
  },
  async executeParsed(_args, ctx) {
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
      const payload = await ctx.memoryIndex.refreshMemoryIndex(scope);
      return { ok: true, output: JSON.stringify({ ok: true, ...payload }) };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
