import { z } from 'zod';

import { appendMemoryNote } from '../../memories/notes-store.js';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const writeMemoryNoteArgsSchema = z.strictObject({
  note: z.string(),
});

export const writeMemoryNoteTool = defineZodTool({
  name: 'write_memory_note',
  description:
    'Append one note to your durable memory in private Home state so later sessions can read it. Notes are append-only and never edited in place; write what you would want to know at the start of the next session. Does not modify Computer files.',
  argsSchema: writeMemoryNoteArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'memory',
    searchHints: ['remember this', 'save a memory', 'write a memory note'],
    tags: ['memory', 'note', 'durable'],
    whenToUse:
      'Persist a durable fact, preference, or convention that should survive into later sessions.',
    notFor:
      'Notes about the current turn only, secrets, or anything that belongs in Computer files.',
  },
  async executeParsed(args, ctx) {
    if (ctx.stateRoot === undefined) {
      return toolError(
        'execution_failed',
        'memory note Home state storage is unavailable',
      );
    }
    try {
      const written = await appendMemoryNote(ctx.stateRoot, args.note);
      return { ok: true, output: JSON.stringify({ ok: true, ...written }) };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
