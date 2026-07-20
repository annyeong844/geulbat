import { isRecord, tryDecodeJson } from '../../../runtime-json.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getErrorMessage, isNotFoundError } from '../../../utils/error.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import { joinWorkspaceGeulbatPath } from '../../../files/geulbat-internal-paths.js';

export interface PlanItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
}

interface PlanState {
  nextId: number;
  items: PlanItem[];
}

const INITIAL_STATE: PlanState = {
  nextId: 1,
  items: [],
};

export async function loadPlanState(
  stateRoot: string,
  threadId: string,
): Promise<PlanState> {
  const filePath = getPlanStatePath(stateRoot, threadId);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = tryDecodeJson(raw, parsePlanState);
    if (!parsed.ok) {
      throw new Error('invalid plan state');
    }
    return parsed.value;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { ...INITIAL_STATE, items: [] };
    }
    throw Object.assign(
      new Error(`invalid plan state: ${getErrorMessage(error)}`),
      {
        code: 'plan_state_invalid',
      },
    );
  }
}

export async function savePlanState(
  stateRoot: string,
  threadId: string,
  state: PlanState,
): Promise<void> {
  const filePath = getPlanStatePath(stateRoot, threadId);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const content = JSON.stringify(state, null, 2) + '\n';
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

function getPlanStatePath(stateRoot: string, threadId: string): string {
  return joinWorkspaceGeulbatPath(
    stateRoot,
    'tool-state',
    'update-plan',
    `${assertValidThreadId(threadId)}.json`,
  );
}

function parsePlanState(value: unknown): PlanState {
  if (!isRecord(value)) {
    throw new Error('plan state must be an object');
  }

  const record = value;
  if (
    typeof record.nextId !== 'number' ||
    !Number.isInteger(record.nextId) ||
    record.nextId < 1
  ) {
    throw new Error('plan state nextId must be a positive integer');
  }
  if (!Array.isArray(record.items)) {
    throw new Error('plan state items must be an array');
  }

  return {
    nextId: record.nextId,
    items: record.items.map(parsePlanItem),
  };
}

function parsePlanItem(value: unknown): PlanItem {
  if (!isRecord(value)) {
    throw new Error('plan item must be an object');
  }

  const record = value;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new Error('plan item id must be a non-empty string');
  }
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    throw new Error('plan item text must be a non-empty string');
  }
  if (
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt)
  ) {
    throw new Error('plan item createdAt must be a finite number');
  }

  if (
    record.status !== 'pending' &&
    record.status !== 'in_progress' &&
    record.status !== 'completed'
  ) {
    throw new Error('plan item status is invalid');
  }

  return {
    id: record.id,
    text: record.text,
    status: record.status,
    createdAt: record.createdAt,
  };
}
