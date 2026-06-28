import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const refreshMemoryIndexArgsSchema = z.strictObject({});

export const refreshMemoryIndexTool = defineZodTool({
  name: 'refresh_memory_index',
  description:
    'Rebuild the derived memory index under .geulbat/index from current workspace source files. Does not modify user workspace documents.',
  argsSchema: refreshMemoryIndexArgsSchema,
  sideEffectLevel: 'write',
  mayMutateWorkspaceFiles: false,
  requiresApproval: true,
  async executeParsed(_args, ctx) {
    if (!ctx.memoryIndex) {
      return toolError('execution_failed', 'memory index store is required');
    }
    try {
      const payload = await ctx.memoryIndex.refreshMemoryIndex(
        ctx.workspaceRoot,
        ctx.projectId ?? 'workspace',
      );
      return { ok: true, output: JSON.stringify({ ok: true, ...payload }) };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
