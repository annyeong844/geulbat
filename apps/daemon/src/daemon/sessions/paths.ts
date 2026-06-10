import { join } from 'node:path';
import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';

function sessionsDir(workspaceRoot: string): string {
  return joinWorkspaceGeulbatPath(workspaceRoot, 'sessions');
}

export function threadFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.jsonl`,
  );
}

export function indexFilePath(workspaceRoot: string): string {
  return join(sessionsDir(workspaceRoot), 'index.json');
}

export function summaryFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.summary.md`,
  );
}

export function artifactStoreFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.artifacts.json`,
  );
}
