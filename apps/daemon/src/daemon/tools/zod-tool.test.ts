import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineZodTool } from './zod-tool.js';

void test('defineZodTool derives the current Tool.parameters subset from a strict object schema', () => {
  const tool = defineZodTool({
    name: 'sample_tool',
    description: 'sample',
    argsSchema: z.strictObject({
      path: z.string().describe('Path to read.'),
      limit: z.number().min(1).optional().describe('Line cap.'),
      recursive: z.boolean().optional().describe('Recursive flag.'),
    }),
    sideEffectLevel: 'read',
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
        description: 'Path to read.',
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
    required: ['path'],
    additionalProperties: false,
  });
});

void test('defineZodTool fails closed when a property falls outside the scalar-only first-slice subset', () => {
  assert.throws(() =>
    defineZodTool({
      name: 'nested_tool',
      description: 'nested',
      argsSchema: z.strictObject({
        payload: z.strictObject({
          path: z.string(),
        }),
      }),
      sideEffectLevel: 'read',
      timeoutMs: 1_000,
      requiresApproval: false,
      async executeParsed() {
        return { ok: true, output: 'ok' };
      },
    }),
  );
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
    timeoutMs: 1_000,
    requiresApproval: false,
    async executeParsed() {
      return { ok: true, output: 'ok' };
    },
  });

  const result = await tool.execute(
    { path: '', mode: 'delete', recursive: true, extra: true },
    { callId: 'call-zod-tool-1', workspaceRoot: '/tmp' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path:/);
  assert.match(result.error ?? '', /mode must be one of: read, write/);
  assert.match(result.error ?? '', /unexpected keys: extra/);
});
