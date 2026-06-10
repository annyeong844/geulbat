import type { ProjectId, RunId, ThreadId } from './ids.js';
import { isPermissionMode, type PermissionMode } from './run-approval.js';
import { isProjectId, isThreadId } from './ids.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

export interface RunRequest {
  prompt: string;
  displayPrompt?: string;
  threadId?: ThreadId;
  projectId: ProjectId;
  currentFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  allowedToolsHint?: string[];
  permissionMode?: PermissionMode;
}

/** Payload for the first `run_ack` event in the websocket run channel. */
export interface RunAck {
  runId: RunId;
  threadId: ThreadId;
}

export type RunSelection = NonNullable<RunRequest['selection']>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isRunSelection(value: unknown): value is RunSelection {
  return (
    isRecord(value) &&
    isNumber(value.startLine) &&
    isNumber(value.endLine) &&
    isString(value.text)
  );
}

export function isRunRequest(value: unknown): value is RunRequest {
  return (
    isRecord(value) &&
    isString(value.prompt) &&
    (value.displayPrompt === undefined || isString(value.displayPrompt)) &&
    isString(value.projectId) &&
    isProjectId(value.projectId) &&
    (value.threadId === undefined ||
      (isString(value.threadId) && isThreadId(value.threadId))) &&
    (value.currentFile === undefined || isString(value.currentFile)) &&
    (value.selection === undefined || isRunSelection(value.selection)) &&
    (value.allowedToolsHint === undefined ||
      isStringArray(value.allowedToolsHint)) &&
    (value.permissionMode === undefined ||
      isPermissionMode(value.permissionMode))
  );
}
