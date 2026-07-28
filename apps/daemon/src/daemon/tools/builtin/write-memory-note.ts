import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import {
  allocateMemoryNoteFileName,
  appendMemoryNote,
} from '../../memories/notes-store.js';
import { catchToolError, toolError } from '../result.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import type { ExecuteResult } from '../types.js';
import { defineZodTool } from '../zod-tool.js';

const writeMemoryNoteArgsSchema = z.strictObject({
  note: z.string(),
});

type WriteMemoryNoteRecoveryState = {
  schemaVersion: 1;
  fileName: string;
  noteDigest: string;
};

function buildNoteDigest(note: string): string {
  return `sha256:${createHash('sha256').update(note.trim()).digest('hex')}`;
}

function parseWriteMemoryNoteRecoveryState(
  value: unknown,
): WriteMemoryNoteRecoveryState | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('fileName' in value) ||
    typeof value.fileName !== 'string' ||
    !('noteDigest' in value) ||
    typeof value.noteDigest !== 'string'
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    fileName: value.fileName,
    noteDigest: value.noteDigest,
  };
}

async function executePreparedMemoryNote(args: {
  stateRoot: string;
  note: string;
  callId: string;
  durability: DurableToolInvocationContext;
  recoveryState: WriteMemoryNoteRecoveryState;
}): Promise<ExecuteResult> {
  let result: ExecuteResult;
  try {
    const written = await appendMemoryNote(args.stateRoot, args.note, {
      preparedFileName: args.recoveryState.fileName,
    });
    result = {
      ok: true,
      output: JSON.stringify({ ok: true, ...written }),
    };
  } catch (error: unknown) {
    result = catchToolError(error);
  }
  await recordDurableToolInvocationResult({
    durability: args.durability,
    callId: args.callId,
    toolName: writeMemoryNoteTool.name,
    result,
  });
  return result;
}

async function recoverMemoryNoteInvocation(args: {
  stateRoot: string;
  note: string;
  callId: string;
  durability: DurableToolInvocationContext;
  invocation: RunCheckpointToolInvocation;
}): Promise<ExecuteResult> {
  const { invocation } = args;
  if (
    invocation.callId !== args.callId ||
    invocation.toolName !== writeMemoryNoteTool.name ||
    invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('write_memory_note recovery invocation identity conflicts');
  }
  const recoveryState = parseWriteMemoryNoteRecoveryState(
    invocation.recoveryState,
  );
  if (
    recoveryState === null ||
    recoveryState.noteDigest !== buildNoteDigest(args.note)
  ) {
    throw new Error('write_memory_note recovery state conflicts');
  }
  if (invocation.status === 'reconciled') {
    return invocation.result;
  }
  return await executePreparedMemoryNote({
    stateRoot: args.stateRoot,
    note: args.note,
    callId: args.callId,
    durability: args.durability,
    recoveryState,
  });
}

export const writeMemoryNoteTool = defineZodTool({
  name: 'write_memory_note',
  description:
    'Append one note to your durable memory in private Home state so later sessions can read it. Notes are append-only and never edited in place; write what you would want to know at the start of the next session. Does not modify Computer files.',
  argsSchema: writeMemoryNoteArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'reconcile_then_replay',
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
      const durability = await resolveDurableToolInvocation(
        ctx,
        writeMemoryNoteTool.name,
      );
      if (durability === undefined) {
        const written = await appendMemoryNote(ctx.stateRoot, args.note);
        return { ok: true, output: JSON.stringify({ ok: true, ...written }) };
      }
      if (durability.invocation !== undefined) {
        return await recoverMemoryNoteInvocation({
          stateRoot: ctx.stateRoot,
          note: args.note,
          callId: ctx.callId,
          durability,
          invocation: durability.invocation,
        });
      }
      const recoveryState: WriteMemoryNoteRecoveryState = {
        schemaVersion: 1,
        fileName: allocateMemoryNoteFileName(),
        noteDigest: buildNoteDigest(args.note),
      };
      const recorded = await recordDurableToolInvocation({
        durability,
        callId: ctx.callId,
        toolName: writeMemoryNoteTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState,
      });
      if (!recorded.changed) {
        return await recoverMemoryNoteInvocation({
          stateRoot: ctx.stateRoot,
          note: args.note,
          callId: ctx.callId,
          durability,
          invocation: recorded.invocation,
        });
      }
      return await executePreparedMemoryNote({
        stateRoot: ctx.stateRoot,
        note: args.note,
        callId: ctx.callId,
        durability,
        recoveryState,
      });
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
