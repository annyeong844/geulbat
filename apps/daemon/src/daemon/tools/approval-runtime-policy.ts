import { toApprovalClass } from '@geulbat/protocol/run-approval';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { resolveSourceMutationTarget } from '../files/file-platform.js';
import type { ToolMetaReader } from './tool-registry-model.js';
import {
  type ApprovalGrantStore,
  type ApprovalClass,
  type ApprovalGrantContext,
} from './approval-grants.js';

type ApprovalPreflight = Record<never, never>;

export function resolveApprovalClass(
  toolName: string,
  args?: Record<string, unknown>,
): ApprovalClass {
  if (toolName !== 'manage_files') {
    return toApprovalClass(toolName);
  }

  const operation = String(args?.['operation'] ?? '').trim();
  if (
    operation === 'create' ||
    operation === 'rename' ||
    operation === 'move' ||
    operation === 'mkdir' ||
    operation === 'delete'
  ) {
    return toApprovalClass(`manage_files:${operation}`);
  }

  return toApprovalClass(toolName);
}

export function shouldAutoApprove(
  approvalGrantContext: ApprovalGrantContext,
  options: {
    approvalGrants: Pick<ApprovalGrantStore, 'hasApprovalGrant'>;
  },
): boolean {
  if (options.approvalGrants.hasApprovalGrant(approvalGrantContext)) {
    return true;
  }

  if (approvalGrantContext.permissionMode !== 'full_access') {
    return false;
  }

  return approvalGrantContext.sideEffectLevel === 'write';
}

export async function collectPreflight(
  workspaceRoot: string,
  args: { path?: unknown },
): Promise<ApprovalPreflight> {
  const inputPath = String(args['path'] ?? '');
  await resolveSourceMutationTarget(workspaceRoot, inputPath, {
    allowMissingLeaf: true,
  });
  return {};
}

export function shouldRequireApproval(
  toolName: string,
  _preflight: ApprovalPreflight | undefined,
  options: {
    toolRegistry: ToolMetaReader;
  },
): boolean {
  const meta = options.toolRegistry.getToolMeta(toolName);
  if (!meta) {
    return true;
  }

  if (meta.requiresApproval) {
    return true;
  }
  if (meta.sideEffectLevel === 'destructive') {
    return true;
  }
  return false;
}

export function resolveRuntimeSideEffectLevel(
  toolName: string,
  args: Record<string, unknown> | undefined,
  options: {
    toolRegistry: ToolMetaReader;
  },
): SideEffectLevel | null {
  const meta = options.toolRegistry.getToolMeta(toolName);
  if (!meta) {
    return null;
  }

  if (
    toolName === 'manage_files' &&
    String(args?.['operation'] ?? '') === 'delete'
  ) {
    return 'destructive';
  }

  return meta.sideEffectLevel;
}
