import { isRecord } from '@geulbat/protocol/runtime-utils';
import { toolError } from './result.js';
import type {
  ExecuteResult,
  RawExecutableTool,
  Tool,
  ToolDescriptor,
  ToolExecutionContext,
  ToolParseFailure,
  ToolParseResult,
} from './types.js';

interface ParsedToolOptions<TArgs extends object> extends ToolDescriptor {
  parseArgs: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    args: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}

export function defineParsedTool<TArgs extends object>(
  options: ParsedToolOptions<TArgs>,
): RawExecutableTool<TArgs> {
  const tool: Tool<TArgs> = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    strict: options.strict,
    sideEffectLevel: options.sideEffectLevel,
    mayMutateWorkspaceFiles: options.mayMutateWorkspaceFiles,
    ...(options.parallelBatchKind
      ? { parallelBatchKind: options.parallelBatchKind }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requiresApproval: options.requiresApproval,
    parseArgs: options.parseArgs,
    executeParsed: options.executeParsed,
  };

  return attachRawExecute(tool);
}

export function readToolArgsRecord(
  raw: unknown,
  allowedKeys: readonly string[],
): ToolParseResult<Record<string, unknown>> {
  if (!isRecord(raw)) {
    return failToolParse('tool arguments must be an object.');
  }

  const extras = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (extras.length > 0) {
    return failToolParse(`unexpected keys: ${extras.join(', ')}.`);
  }

  return { ok: true, value: raw };
}

export function failToolParse(message: string): ToolParseFailure {
  return { ok: false, message };
}

function attachRawExecute<TArgs extends object>(
  tool: Tool<TArgs>,
): RawExecutableTool<TArgs> {
  return {
    ...tool,
    async execute(raw, ctx) {
      const parsed = tool.parseArgs(raw);
      if (!parsed.ok) {
        return toolError('invalid_args', parsed.message);
      }
      return await tool.executeParsed(parsed.value, ctx);
    },
  };
}
