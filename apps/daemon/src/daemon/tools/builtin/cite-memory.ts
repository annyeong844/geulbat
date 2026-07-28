import { z } from 'zod';

import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import {
  prepareMemoryEntryUsage,
  recordMemoryEntryUsage,
  recordPreparedMemoryEntryUsage,
  type PreparedMemoryEntryUsage,
} from '../../memories/entries-store.js';
import { catchToolError, toolError } from '../result.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import type { ExecuteResult } from '../types.js';
import { defineZodTool } from '../zod-tool.js';

const citeMemoryArgsSchema = z.strictObject({
  entryIds: z.array(z.string()).min(1),
});

const citeMemoryRecoveryStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string(),
  at: z.string(),
  requested: z.array(z.string()),
  recorded: z.array(z.string()),
  unknown: z.array(z.string()),
  recordedDigest: z.string(),
});

function hasSameRequestedEntryIds(
  prepared: PreparedMemoryEntryUsage,
  entryIds: readonly string[],
): boolean {
  const requested = [...new Set(entryIds)];
  return (
    prepared.requested.length === requested.length &&
    prepared.requested.every((entryId, index) => entryId === requested[index])
  );
}

async function executePreparedMemoryCitation(args: {
  stateRoot: string;
  callId: string;
  durability: DurableToolInvocationContext;
  prepared: PreparedMemoryEntryUsage;
}): Promise<ExecuteResult> {
  let result: ExecuteResult;
  try {
    const outcome = await recordPreparedMemoryEntryUsage(
      args.stateRoot,
      args.prepared,
    );
    result = {
      ok: true,
      output: JSON.stringify({ ok: true, ...outcome }),
    };
  } catch (error: unknown) {
    result = catchToolError(error);
  }
  await recordDurableToolInvocationResult({
    durability: args.durability,
    callId: args.callId,
    toolName: citeMemoryTool.name,
    result,
  });
  return result;
}

async function recoverMemoryCitationInvocation(args: {
  stateRoot: string;
  entryIds: readonly string[];
  callId: string;
  durability: DurableToolInvocationContext;
  invocation: RunCheckpointToolInvocation;
}): Promise<ExecuteResult> {
  const { invocation } = args;
  if (
    invocation.callId !== args.callId ||
    invocation.toolName !== citeMemoryTool.name ||
    invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('cite_memory recovery invocation identity conflicts');
  }
  const parsed = citeMemoryRecoveryStateSchema.safeParse(
    invocation.recoveryState,
  );
  if (
    !parsed.success ||
    !hasSameRequestedEntryIds(parsed.data, args.entryIds)
  ) {
    throw new Error('cite_memory recovery state conflicts');
  }
  if (invocation.status === 'reconciled') {
    return invocation.result;
  }
  return await executePreparedMemoryCitation({
    stateRoot: args.stateRoot,
    callId: args.callId,
    durability: args.durability,
    prepared: parsed.data,
  });
}

export const citeMemoryTool = defineZodTool({
  name: 'cite_memory',
  description:
    'Record which addressed memory entries you actually relied on for this reply. Call it once, only for entries that shaped the answer. The recorded counts are what a later consolidation uses to judge which entries keep earning their place. Does not modify Computer files.',
  argsSchema: citeMemoryArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'reconcile_then_replay',
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
      const durability = await resolveDurableToolInvocation(
        ctx,
        citeMemoryTool.name,
      );
      if (durability === undefined) {
        const outcome = await recordMemoryEntryUsage(
          ctx.stateRoot,
          args.entryIds,
        );
        return {
          ok: true,
          output: JSON.stringify({ ok: true, ...outcome }),
        };
      }
      if (durability.invocation !== undefined) {
        return await recoverMemoryCitationInvocation({
          stateRoot: ctx.stateRoot,
          entryIds: args.entryIds,
          callId: ctx.callId,
          durability,
          invocation: durability.invocation,
        });
      }
      const prepared = await prepareMemoryEntryUsage(
        ctx.stateRoot,
        args.entryIds,
      );
      const recorded = await recordDurableToolInvocation({
        durability,
        callId: ctx.callId,
        toolName: citeMemoryTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: prepared,
      });
      if (!recorded.changed) {
        return await recoverMemoryCitationInvocation({
          stateRoot: ctx.stateRoot,
          entryIds: args.entryIds,
          callId: ctx.callId,
          durability,
          invocation: recorded.invocation,
        });
      }
      return await executePreparedMemoryCitation({
        stateRoot: ctx.stateRoot,
        callId: ctx.callId,
        durability,
        prepared,
      });
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
