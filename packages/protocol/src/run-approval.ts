import type { RunId, ThreadId } from './ids.js';
import { isRunId, isThreadId } from './ids.js';
import { isBoolean, isRecord, isString } from './runtime-utils.js';
import {
  isSideEffectLevel,
  type SideEffectLevel,
} from './side-effect-level.js';

export const PERMISSION_MODES = ['basic', 'full_access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export const APPROVAL_GRANT_SCOPES = [
  'once',
  'run',
  'thread',
  'session',
] as const;
export type ApprovalGrantScope = (typeof APPROVAL_GRANT_SCOPES)[number];

export function isApprovalGrantScope(
  value: unknown,
): value is ApprovalGrantScope {
  return (
    typeof value === 'string' &&
    (APPROVAL_GRANT_SCOPES as readonly string[]).includes(value)
  );
}

export const WELL_KNOWN_APPROVAL_CLASSES = [
  'write_file',
  'patch_file',
  'manage_files',
  'manage_files:create',
  'manage_files:rename',
  'manage_files:move',
  'manage_files:mkdir',
  'manage_files:delete',
  'refresh_memory_index',
] as const;

export type WellKnownApprovalClass =
  (typeof WELL_KNOWN_APPROVAL_CLASSES)[number];

export function isWellKnownApprovalClass(
  value: unknown,
): value is WellKnownApprovalClass {
  return (
    typeof value === 'string' &&
    (WELL_KNOWN_APPROVAL_CLASSES as readonly string[]).includes(value)
  );
}

const APPROVAL_CLASS_PATTERN = /^[a-z0-9]+(?:[_:-][a-z0-9]+)*$/;

declare const approvalClassBrand: unique symbol;
type CustomApprovalClass = string & {
  readonly [approvalClassBrand]: 'CustomApprovalClass';
};

export type ApprovalClass = WellKnownApprovalClass | CustomApprovalClass;

export function isApprovalClass(value: unknown): value is ApprovalClass {
  return isString(value) && APPROVAL_CLASS_PATTERN.test(value);
}

export function toApprovalClass(value: string): ApprovalClass {
  if (!isApprovalClass(value)) {
    throw new Error(
      `approvalClass must match ${APPROVAL_CLASS_PATTERN.source}`,
    );
  }
  return value;
}

export interface ApprovalRequest {
  callId: string;
  runId: RunId;
  threadId: ThreadId;
  approved: boolean;
  grantScope: ApprovalGrantScope;
}

export interface ApprovalResponse {
  ok: boolean;
}

export interface ApprovalRequired {
  callId: string;
  runId: RunId;
  threadId: ThreadId;
  toolName: string;
  approvalClass: ApprovalClass;
  permissionMode: PermissionMode;
  argumentsPreview: Record<string, unknown>;
  sideEffectLevel: SideEffectLevel;
}

export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return (
    isRecord(value) &&
    isString(value.callId) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isBoolean(value.approved) &&
    isApprovalGrantScope(value.grantScope)
  );
}

export function isApprovalRequired(value: unknown): value is ApprovalRequired {
  return (
    isRecord(value) &&
    isString(value.callId) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isString(value.toolName) &&
    isApprovalClass(value.approvalClass) &&
    isPermissionMode(value.permissionMode) &&
    isRecord(value.argumentsPreview) &&
    isSideEffectLevel(value.sideEffectLevel)
  );
}

export function isApprovalResponse(value: unknown): value is ApprovalResponse {
  return isRecord(value) && isBoolean(value.ok);
}
