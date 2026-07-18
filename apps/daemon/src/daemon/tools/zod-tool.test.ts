import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineZodTool, zodSchemaToToolParameters } from './zod-tool.js';

void test('defineZodTool derives the current Tool.parameters subset from a strict object schema', () => {
  const tool = defineZodTool({
    name: 'sample_tool',
    description: 'sample',
    argsSchema: z.strictObject({
      path: z.string().min(1).describe('Path to read.'),
      homepage: z.string().url().describe('Homepage URL.'),
      include: z
        .string()
        .max(256)
        .regex(/^(?!!).*$/u)
        .optional()
        .describe('Include glob.'),
      limit: z.number().min(1).optional().describe('Line cap.'),
      recursive: z.boolean().optional().describe('Recursive flag.'),
    }),
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    timeoutMs: 1_000,
    requiresApproval: false,
    async executeParsed() {
      return { ok: true, output: 'ok' };
    },
  });

  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Path to read.',
      },
      homepage: {
        type: 'string',
        format: 'uri',
        description: 'Homepage URL.',
      },
      include: {
        type: 'string',
        maxLength: 256,
        pattern: '^(?!!).*$',
        description: 'Include glob.',
      },
      limit: {
        type: 'number',
        minimum: 1,
        description: 'Line cap.',
      },
      recursive: {
        type: 'boolean',
        description: 'Recursive flag.',
      },
    },
    required: ['path', 'homepage'],
    additionalProperties: false,
  });
});

void test('defineZodTool projects supported array/object properties', () => {
  const tool = defineZodTool({
    name: 'nested_tool',
    description: 'nested',
    argsSchema: z.strictObject({
      items: z
        .array(
          z.strictObject({
            text: z.string().min(1),
            status: z.enum(['pending', 'completed']),
          }),
        )
        .min(1)
        .describe('Ordered items.'),
    }),
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    timeoutMs: 1_000,
    requiresApproval: false,
    async executeParsed() {
      return { ok: true, output: 'ok' };
    },
  });

  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              minLength: 1,
            },
            status: {
              type: 'string',
              enum: ['pending', 'completed'],
            },
          },
          required: ['text', 'status'],
          additionalProperties: false,
        },
        description: 'Ordered items.',
        minItems: 1,
      },
    },
    required: ['items'],
    additionalProperties: false,
  });
});

void test('zodSchemaToToolParameters projects root oneOf object branches', () => {
  const parameters = zodSchemaToToolParameters(
    z.discriminatedUnion('action', [
      z.strictObject({
        action: z.literal('create'),
        path: z.string().min(1),
      }),
      z.strictObject({
        action: z.literal('rename'),
        path: z.string().min(1),
        destination: z.string().min(1),
      }),
    ]),
  );

  assert.deepEqual(parameters, {
    oneOf: [
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            const: 'create',
          },
          path: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['action', 'path'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            const: 'rename',
          },
          path: {
            type: 'string',
            minLength: 1,
          },
          destination: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['action', 'path', 'destination'],
        additionalProperties: false,
      },
    ],
  });
});

void test('zodSchemaToToolParameters projects root anyOf object branches', () => {
  const parameters = zodSchemaToToolParameters(
    z.union([
      z.strictObject({
        old_string: z.literal(''),
        new_string: z.string(),
      }),
      z.strictObject({
        old_string: z.string().min(1),
        new_string: z.string(),
      }),
    ]),
  );

  assert.deepEqual(parameters, {
    anyOf: [
      {
        type: 'object',
        properties: {
          old_string: {
            type: 'string',
            const: '',
          },
          new_string: {
            type: 'string',
          },
        },
        required: ['old_string', 'new_string'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          old_string: {
            type: 'string',
            minLength: 1,
          },
          new_string: {
            type: 'string',
          },
        },
        required: ['old_string', 'new_string'],
        additionalProperties: false,
      },
    ],
  });
});

void test('defineZodTool formats invalid_args messages as stable path-based strings', async () => {
  const tool = defineZodTool({
    name: 'sample_tool',
    description: 'sample',
    argsSchema: z.strictObject({
      path: z.string().min(1, 'path must not be empty.'),
      mode: z.enum(['read', 'write']).optional(),
      recursive: z.boolean().optional(),
    }),
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    timeoutMs: 1_000,
    requiresApproval: false,
    async executeParsed() {
      return { ok: true, output: 'ok' };
    },
  });

  const result = await tool.execute(
    { path: '', mode: 'delete', recursive: true, extra: true },
    { callId: 'call-zod-tool-1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path:/);
  assert.match(result.error ?? '', /mode must be one of: read, write/);
  assert.match(result.error ?? '', /unexpected keys: extra/);
});
