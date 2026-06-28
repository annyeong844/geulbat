import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { loadTodoState, saveTodoState, type TodoItem } from './todo/store.js';
import { defineZodTool } from '../zod-tool.js';

const TODO_ACTIONS = ['add', 'update', 'complete', 'remove', 'list'] as const;
const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const todoIdSchema = z
  .string()
  .describe('The task ID for update/complete/remove actions.');
const todoTextSchema = z
  .string()
  .describe('The task description for add/update actions.');
const todoStatusSchema = z
  .enum(TODO_STATUSES)
  .describe('The task status for update actions.');

const todoArgsSchema = z
  .strictObject({
    action: z
      .enum(TODO_ACTIONS)
      .describe('The action to perform on the task list.'),
    id: todoIdSchema.optional(),
    text: todoTextSchema.optional(),
    status: todoStatusSchema.optional(),
  })
  .superRefine((args, ctx) => {
    if (args.action === 'add' && !args.text) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'text is required for add.',
      });
    }

    if (
      (args.action === 'update' ||
        args.action === 'complete' ||
        args.action === 'remove') &&
      !args.id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: `id is required for ${args.action}.`,
      });
    }
  });

const todoParametersSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'),
    id: todoIdSchema.optional(),
    text: todoTextSchema,
    status: todoStatusSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('update'),
    id: todoIdSchema,
    text: todoTextSchema.optional(),
    status: todoStatusSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('complete'),
    id: todoIdSchema,
    text: todoTextSchema.optional(),
    status: todoStatusSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('remove'),
    id: todoIdSchema,
    text: todoTextSchema.optional(),
    status: todoStatusSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('list'),
    id: todoIdSchema.optional(),
    text: todoTextSchema.optional(),
    status: todoStatusSchema.optional(),
  }),
]);

export const todoTool = defineZodTool({
  name: 'todo',
  description:
    'Manage a per-thread task list for tracking progress on multi-step work. Supports adding, updating, completing, removing, and listing tasks.',
  argsSchema: todoArgsSchema,
  parametersSchema: todoParametersSchema,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    const action = args.action;
    const threadId = ctx.threadId;
    if (!threadId) {
      return toolError(
        'execution_failed',
        'thread context is required for todo.',
      );
    }

    let state;
    try {
      state = await loadTodoState(ctx.workspaceRoot, threadId);
    } catch (error: unknown) {
      return catchToolError(error);
    }

    switch (action) {
      case 'add': {
        const text = String(args.text ?? '');
        const id = String(state.nextId++);
        const item: TodoItem = {
          id,
          text,
          status: 'pending',
          createdAt: Date.now(),
        };
        state.items.push(item);
        await saveTodoState(ctx.workspaceRoot, threadId, state);
        return { ok: true, output: JSON.stringify({ action: 'add', item }) };
      }

      case 'update': {
        const id = String(args.id ?? '');
        const item = state.items.find((candidate) => candidate.id === id);
        if (!item) {
          return toolError('not_found', `Task ${id} not found.`);
        }
        if (args.text != null) item.text = String(args.text);
        if (args.status != null) item.status = args.status;
        await saveTodoState(ctx.workspaceRoot, threadId, state);
        return { ok: true, output: JSON.stringify({ action: 'update', item }) };
      }

      case 'complete': {
        const id = String(args.id ?? '');
        const item = state.items.find((candidate) => candidate.id === id);
        if (!item) {
          return toolError('not_found', `Task ${id} not found.`);
        }
        item.status = 'completed';
        await saveTodoState(ctx.workspaceRoot, threadId, state);
        return {
          ok: true,
          output: JSON.stringify({ action: 'complete', item }),
        };
      }

      case 'remove': {
        const id = String(args.id ?? '');
        const index = state.items.findIndex((candidate) => candidate.id === id);
        if (index === -1) {
          return toolError('not_found', `Task ${id} not found.`);
        }
        state.items.splice(index, 1);
        await saveTodoState(ctx.workspaceRoot, threadId, state);
        return { ok: true, output: JSON.stringify({ action: 'remove', id }) };
      }

      case 'list': {
        const items = state.items.slice();
        return {
          ok: true,
          output: JSON.stringify({
            action: 'list',
            total: items.length,
            items,
          }),
        };
      }
    }
  },
});
