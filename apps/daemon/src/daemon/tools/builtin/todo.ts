import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { loadTodoState, saveTodoState, type TodoItem } from './todo/store.js';
import { defineZodTool } from '../zod-tool.js';

const TODO_ACTIONS = ['add', 'update', 'complete', 'remove', 'list'] as const;
const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const todoArgsSchema = z.strictObject({
  action: z
    .enum(TODO_ACTIONS)
    .describe('The action to perform on the task list.'),
  id: z
    .string()
    .optional()
    .describe('The task ID for update/complete/remove actions.'),
  text: z
    .string()
    .optional()
    .describe('The task description for add/update actions.'),
  status: z
    .enum(TODO_STATUSES)
    .optional()
    .describe('The task status for update actions.'),
});

export const todoTool = defineZodTool({
  name: 'todo',
  description:
    'Manage a per-thread task list for tracking progress on multi-step work. Supports adding, updating, completing, removing, and listing tasks.',
  argsSchema: todoArgsSchema,
  sideEffectLevel: 'none',
  timeoutMs: 5_000,
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
        if (!text) {
          return toolError('invalid_args', 'text is required for add.');
        }
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
        if (!id) {
          return toolError('invalid_args', 'id is required for update.');
        }
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
        if (!id) {
          return toolError('invalid_args', 'id is required for complete.');
        }
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
        if (!id) {
          return toolError('invalid_args', 'id is required for remove.');
        }
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
