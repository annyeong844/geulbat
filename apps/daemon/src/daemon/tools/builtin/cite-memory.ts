import { z } from 'zod';

import { recordMemoryEntryUsage } from '../../memories/entries-store.js';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const citeMemoryArgsSchema = z.strictObject({
  entryIds: z.array(z.string()).min(1),
});

export const citeMemoryTool = defineZodTool({
  name: 'cite_memory',
  description:
    'Record which addressed memory entries you actually relied on for this reply. Call it once, only for entries that shaped the answer. The recorded counts are what a later consolidation uses to judge which entries keep earning their place. Does not modify Computer files.',
  argsSchema: citeMemoryArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'memory',
    searchHints: ['cite memory', 'record memory use', 'memory usage'],
    tags: ['memory', 'citation', 'usage'],
    whenToUse:
      'After relying on one or more addressed memory entries in the current reply.',
    notFor:
      'Entries you only read past, pending notes without an address, or Computer files.',
  },
  async executeParsed(args, ctx) {
    if (ctx.stateRoot === undefined) {
      return toolError(
        'execution_failed',
        'memory citation Home state storage is unavailable',
      );
    }
    try {
      const outcome = await recordMemoryEntryUsage(
        ctx.stateRoot,
        args.entryIds,
      );
      return {
        ok: true,
        output: JSON.stringify({ ok: true, ...outcome }),
      };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
