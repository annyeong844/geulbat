import { isRecord } from '@geulbat/protocol/runtime-utils';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { z } from 'zod';
import type {
  RawExecutableTool,
  ToolExecutionContext,
  ExecuteResult,
  ToolParameters,
} from './types.js';
import { defineParsedTool, failToolParse } from './parsed-tool.js';
import type { ParallelToolBatchKind } from './types.js';

type AnyZodObject = z.ZodObject<z.core.$ZodLooseShape>;

interface ZodToolOptions<TSchema extends AnyZodObject> {
  name: string;
  description: string;
  argsSchema: TSchema;
  sideEffectLevel: SideEffectLevel;
  mayMutateWorkspaceFiles?: boolean;
  parallelBatchKind?: ParallelToolBatchKind;
  timeoutMs?: number;
  requiresApproval: boolean;
  executeParsed: (
    args: z.output<TSchema>,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}

export function defineZodTool<TSchema extends AnyZodObject>(
  options: ZodToolOptions<TSchema>,
): RawExecutableTool<z.output<TSchema>> {
  return defineParsedTool({
    name: options.name,
    description: options.description,
    parameters: zodSchemaToToolParameters(options.argsSchema),
    strict: true,
    sideEffectLevel: options.sideEffectLevel,
    mayMutateWorkspaceFiles: options.mayMutateWorkspaceFiles ?? false,
    ...(options.parallelBatchKind
      ? { parallelBatchKind: options.parallelBatchKind }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requiresApproval: options.requiresApproval,
    parseArgs(raw) {
      const parsed = options.argsSchema.safeParse(raw);
      if (!parsed.success) {
        return failToolParse(formatZodToolParseError(parsed.error));
      }
      return { ok: true, value: parsed.data };
    },
    async executeParsed(args, ctx) {
      return options.executeParsed(args, ctx);
    },
  });
}

export function zodSchemaToToolParameters(
  schema: AnyZodObject,
): ToolParameters {
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' });
  return normalizeRootObjectSchema(jsonSchema);
}

function normalizeRootObjectSchema(value: unknown): ToolParameters {
  const record = asRecord(
    value,
    'Tool schema must convert to an object schema.',
  );
  if (record.type !== 'object') {
    throw new Error('Tool schema root must have type "object".');
  }
  if (record.additionalProperties !== false) {
    throw new Error('Tool schema root must set additionalProperties to false.');
  }

  const propertiesRecord = asRecord(
    record.properties,
    'Tool schema root must provide properties.',
  );

  const properties: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(propertiesRecord)) {
    properties[key] = normalizeScalarPropertySchema(propertySchema, key);
  }

  const required = normalizeRequired(record.required);

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function normalizeScalarPropertySchema(
  value: unknown,
  key: string,
): Record<string, unknown> {
  const record = asRecord(
    value,
    `Tool property "${key}" must convert to a scalar schema.`,
  );

  if (
    'properties' in record ||
    'items' in record ||
    'anyOf' in record ||
    'allOf' in record ||
    'oneOf' in record ||
    '$ref' in record
  ) {
    throw new Error(
      `Tool property "${key}" must stay within the scalar-only first-slice subset.`,
    );
  }

  const type = record.type;
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'boolean'
  ) {
    throw new Error(`Tool property "${key}" has unsupported type.`);
  }

  const normalized: Record<string, unknown> = { type };
  if (typeof record.description === 'string') {
    normalized.description = record.description;
  }
  if (Array.isArray(record.enum)) {
    normalized.enum = record.enum;
  }
  if (typeof record.minimum === 'number') {
    normalized.minimum = record.minimum;
  }
  if (typeof record.maximum === 'number') {
    normalized.maximum = record.maximum;
  }

  return normalized;
}

function normalizeRequired(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Tool schema required must be a string array.');
  }
  return [...value];
}

function asRecord(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

export function formatZodToolParseError(error: z.ZodError): string {
  const formatted = error.issues
    .slice(0, 3)
    .map(formatZodIssue)
    .filter((message) => message.length > 0);

  return formatted.length > 0 ? formatted.join(' ') : 'invalid tool arguments.';
}

function formatZodIssue(issue: z.ZodIssue): string {
  const path = Array.isArray(issue.path)
    ? issue.path.map(String).join('.')
    : 'args';

  if (issue.code === 'unrecognized_keys') {
    return `unexpected keys: ${issue.keys.join(', ')}.`;
  }

  if (
    issue.code === 'invalid_type' &&
    path !== 'args' &&
    issue.message.includes('received undefined')
  ) {
    return `${path} is required.`;
  }

  if (issue.code === 'invalid_value' && path !== 'args') {
    return `${path} must be one of: ${issue.values.map(String).join(', ')}.`;
  }

  if (path === 'args') {
    return issue.message;
  }

  return `${path}: ${issue.message}`;
}
