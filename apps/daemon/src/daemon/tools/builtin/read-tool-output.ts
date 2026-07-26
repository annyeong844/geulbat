import { z } from 'zod';
import { readToolOutputSnapshot } from '../../files/tool-output-store.js';
import { isRecord, tryParseJson } from '../../runtime-json.js';
import { toolError } from '../result.js';
import type { ToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';
import type { AgentRuntimeSubagentServices } from '../../daemon-runtime-contract.js';

// Terminal deliveries are the only runtime service this tool reads.
type ReadToolOutputServices = {
  subagent: Pick<AgentRuntimeSubagentServices, 'terminalDeliveries'>;
};

function structuredItemFieldForTool(
  toolName: string,
): 'entries' | 'results' | null {
  if (toolName === 'list_files') {
    return 'entries';
  }
  if (toolName === 'search_files') {
    return 'results';
  }
  return null;
}

const readToolOutputArgsSchema = z.strictObject({
  outputRef: z
    .string()
    .min(1, 'outputRef is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'outputRef is required.',
    })
    .describe('Opaque tool output reference returned by a previous tool call.'),
  mode: z
    .enum(['characters', 'items'])
    .optional()
    .describe(
      'Paging mode. Omit this or use characters for exact character pages. Use items only for list_files entries or search_files results.',
    ),
  offset: z
    .number()
    .int('offset must be an integer.')
    .min(0, 'offset must be non-negative.')
    .optional()
    .describe(
      'Zero-based character or item offset, according to mode. Defaults to 0.',
    ),
  limit: z
    .number()
    .int('limit must be an integer.')
    .min(1, 'limit must be positive.')
    .describe(
      'Required character or item count for this bounded page, according to mode.',
    ),
});

function readSubagentResultPage(
  args: z.infer<typeof readToolOutputArgsSchema>,
  ctx: ToolExecutionContext,
) {
  if (args.mode === 'items') {
    return toolError(
      'invalid_args',
      'read_tool_output item mode is not available for subagent result references.',
    );
  }
  const services: ReadToolOutputServices | undefined = ctx.runtimeServices;
  const terminalStore = services?.subagent.terminalDeliveries;
  if (terminalStore === undefined || ctx.threadId === undefined) {
    return toolError(
      'persistence_unavailable',
      'durable subagent result storage is unavailable in this context.',
    );
  }

  let terminal;
  try {
    terminal = terminalStore.readSubagentTerminalOutcomeByResultRef(
      args.outputRef,
    );
  } catch {
    return toolError(
      'persistence_unavailable',
      'durable subagent result could not be read.',
    );
  }
  if (terminal === undefined) {
    return toolError('not_found', 'durable subagent result was not found.');
  }
  if (
    !terminalStore.isSubagentResultReaderInOwnerScope({
      ownerThreadId: terminal.ownerThreadId,
      parentRunId: terminal.result.parentRunId,
      readerThreadId: ctx.threadId,
    })
  ) {
    return toolError(
      'access_denied',
      'durable subagent result is outside this run tree.',
    );
  }

  const content = terminal.result.result;
  const totalChars = content.length;
  const offset = args.offset ?? 0;
  const startOffset = Math.min(offset, totalChars);
  const endOffset = Math.min(startOffset + args.limit, totalChars);
  const hasMore = endOffset < totalChars;

  return {
    ok: true as const,
    output: JSON.stringify({
      ok: true,
      outputRef: terminal.resultRef,
      resultDigest: terminal.resultDigest,
      sourceType: 'subagent_result',
      childRunId: terminal.result.childRunId,
      terminalState: terminal.result.terminalState,
      ...(terminal.result.reason === undefined
        ? {}
        : { reason: terminal.result.reason }),
      offset: startOffset,
      limit: args.limit,
      endOffset,
      totalChars,
      hasMore,
      nextOffset: hasMore ? endOffset : null,
      content: content.slice(startOffset, endOffset),
    }),
  };
}

export const readToolOutputTool = defineZodTool({
  name: 'read_tool_output',
  description:
    'Read one explicit bounded page of a previously offloaded tool output snapshot or durable subagent result by opaque outputRef. Durable subagent refs are readable by their owner or a child launched by that owner in the same parent run, so the owner can delegate refs for bounded fan-in without opening unrelated threads. Character paging remains the default. For list_files or search_files snapshots, mode="items" returns exact entries or results by zero-based item range without replaying unrelated raw JSON. Pass the required limit and an optional offset; continue from nextOffset only when more evidence is needed.',
  argsSchema: readToolOutputArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
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
    whenToUse:
      'Page through a previously offloaded tool output snapshot, using exact item ranges for list_files or search_files positional evidence.',
    notFor: 'Reading arbitrary Computer files or raw .geulbat paths.',
  },
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'invalid_args',
        'read_tool_output requires an agent thread context.',
      );
    }

    if (args.outputRef.startsWith('subagent-result:')) {
      return readSubagentResultPage(args, ctx);
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
    if (args.mode === 'items') {
      const itemField = structuredItemFieldForTool(snapshot.toolName);
      if (itemField === null) {
        return toolError(
          'invalid_args',
          'read_tool_output item mode is available only for list_files and search_files snapshots.',
        );
      }
      const parsedOutput = tryParseJson(snapshot.output);
      if (
        !parsedOutput.ok ||
        !isRecord(parsedOutput.value) ||
        !Array.isArray(parsedOutput.value[itemField])
      ) {
        return toolError(
          'invalid_args',
          `The ${snapshot.toolName} snapshot does not contain a valid ${itemField} array.`,
        );
      }

      const items = parsedOutput.value[itemField];
      const totalItems = items.length;
      const offset = args.offset ?? 0;
      const startOffset = Math.min(offset, totalItems);
      const endOffset = Math.min(startOffset + args.limit, totalItems);
      const hasMore = endOffset < totalItems;

      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          outputRef: snapshot.outputRef,
          toolName: snapshot.toolName,
          contentType: snapshot.contentType,
          mode: 'items',
          itemField,
          offset: startOffset,
          limit: args.limit,
          endOffset,
          totalItems,
          hasMore,
          nextOffset: hasMore ? endOffset : null,
          items: items.slice(startOffset, endOffset),
        }),
      };
    }

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
