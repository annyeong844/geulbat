import { toApprovalClass } from '@geulbat/protocol/run-approval';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { resolveSourceMutationTarget } from '../files/file-platform.js';
import { resolveComputerFileToolPath } from './file-tool-root.js';
import type { ToolMetaReader } from './tool-registry-model.js';
import type {
  ApprovalGrantStore,
  ApprovalClass,
  ApprovalGrantContext,
} from './approval-grants.js';

type ApprovalPreflight = Record<never, never>;

const FILE_MUTATION_TOOL_NAMES = new Set([
  'write_file',
  'apply_patch',
  'manage_files',
]);

export function resolveApprovalClass(
  toolName: string,
  args?: Record<string, unknown>,
): ApprovalClass {
  const baseClass = resolveBaseApprovalClass(toolName, args);
  return toApprovalClass(
    isComputerFileMutation(toolName) ? `${baseClass}:computer` : baseClass,
  );
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

  // 전체 액세스는 말 그대로 전부 자동 승인한다 — 위험 수용은 모드를 켜는
  // 시점(⚠ 표시)에 이미 이루어졌고, 매 호출 재확인은 소유자 결정으로 제거
  // (2026-07-12). basic 모드는 여전히 write/destructive 모두 승인창을 띄운다.
  return (
    approvalGrantContext.sideEffectLevel === 'write' ||
    approvalGrantContext.sideEffectLevel === 'destructive'
  );
}

export async function collectPreflight(
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  args: { path?: unknown },
): Promise<ApprovalPreflight> {
  const inputPath = typeof args['path'] === 'string' ? args['path'] : '';
  const filePath = resolveComputerFileToolPath(ctx, inputPath);
  await resolveSourceMutationTarget(filePath.absoluteRoot, filePath.path, {
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

  if (toolName === 'manage_files' && args?.['operation'] === 'delete') {
    return 'destructive';
  }

  return meta.sideEffectLevel;
}

function resolveBaseApprovalClass(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (toolName !== 'manage_files') {
    return toolName;
  }

  const rawOperation = args?.['operation'];
  const operation = typeof rawOperation === 'string' ? rawOperation.trim() : '';
  if (
    operation === 'create' ||
    operation === 'rename' ||
    operation === 'move' ||
    operation === 'mkdir' ||
    operation === 'delete'
  ) {
    return `manage_files:${operation}`;
  }

  return toolName;
}

function isComputerFileMutation(toolName: string): boolean {
  return FILE_MUTATION_TOOL_NAMES.has(toolName);
}
