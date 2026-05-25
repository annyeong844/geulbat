import { isRecord, tryDecodeJson } from '@geulbat/protocol/runtime-utils';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getErrorMessage, isNotFoundError } from '../../../utils/error.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import { joinWorkspaceGeulbatPath } from '../../../files/geulbat-internal-paths.js';

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
}

interface TodoState {
  nextId: number;
  items: TodoItem[];
}

const INITIAL_STATE: TodoState = {
  nextId: 1,
  items: [],
};

export async function loadTodoState(
  workspaceRoot: string,
  threadId: string,
): Promise<TodoState> {
  const filePath = getTodoStatePath(workspaceRoot, threadId);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = tryDecodeJson(raw, parseTodoState);
    if (!parsed.ok) {
      throw new Error('invalid todo state');
    }
    return parsed.value;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { ...INITIAL_STATE, items: [] };
    }
    throw Object.assign(
      new Error(`invalid todo state: ${getErrorMessage(error)}`),
      {
        code: 'todo_state_invalid',
      },
    );
  }
}

export async function saveTodoState(
  workspaceRoot: string,
  threadId: string,
  state: TodoState,
): Promise<void> {
  const filePath = getTodoStatePath(workspaceRoot, threadId);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const content = JSON.stringify(state, null, 2) + '\n';
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

function getTodoStatePath(workspaceRoot: string, threadId: string): string {
  return joinWorkspaceGeulbatPath(
    workspaceRoot,
    'tool-state',
    'todo',
    `${assertValidThreadId(threadId)}.json`,
  );
}

function parseTodoState(value: unknown): TodoState {
  if (!isRecord(value)) {
    throw new Error('todo state must be an object');
  }

  const record = value;
  if (
    typeof record.nextId !== 'number' ||
    !Number.isInteger(record.nextId) ||
    record.nextId < 1
  ) {
    throw new Error('todo state nextId must be a positive integer');
  }
  if (!Array.isArray(record.items)) {
    throw new Error('todo state items must be an array');
  }

  return {
    nextId: record.nextId,
    items: record.items.map(parseTodoItem),
  };
}

function parseTodoItem(value: unknown): TodoItem {
  if (!isRecord(value)) {
    throw new Error('todo item must be an object');
  }

  const record = value;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new Error('todo item id must be a non-empty string');
  }
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    throw new Error('todo item text must be a non-empty string');
  }
  if (
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt)
  ) {
    throw new Error('todo item createdAt must be a finite number');
  }

  if (
    record.status !== 'pending' &&
    record.status !== 'in_progress' &&
    record.status !== 'completed'
  ) {
    throw new Error('todo item status is invalid');
  }

  return {
    id: record.id,
    text: record.text,
    status: record.status,
    createdAt: record.createdAt,
  };
}
