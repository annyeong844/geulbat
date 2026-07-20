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

interface ApprovalPreflightTarget {
  argument: 'path' | 'destination';
  canonicalTargetId: string;
}

export interface ApprovalPreflight {
  mutationTargets: ApprovalPreflightTarget[];
}

const FILE_MUTATION_TOOL_NAMES = new Set([
  'write_file',
  'apply_patch',
  'manage_files',
]);

const COMPUTER_FILE_PREFLIGHT_ARGUMENTS = new Map<
  string,
  readonly ApprovalPreflightTarget['argument'][]
>([
  ['write_file', ['path']],
  ['manage_files', ['path', 'destination']],
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
  toolName: string,
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  args: Record<string, unknown>,
): Promise<ApprovalPreflight | undefined> {
  const preflightArguments = COMPUTER_FILE_PREFLIGHT_ARGUMENTS.get(toolName);
  if (preflightArguments === undefined) {
    return undefined;
  }

  const mutationTargets: ApprovalPreflightTarget[] = [];
  for (const argument of preflightArguments) {
    const inputPath = args[argument];
    if (typeof inputPath !== 'string') {
      continue;
    }
    const filePath = resolveComputerFileToolPath(ctx, inputPath);
    const resolvedPath = await resolveSourceMutationTarget(
      filePath.absoluteRoot,
      filePath.path,
      { allowMissingLeaf: true },
    );
    mutationTargets.push({
      argument,
      canonicalTargetId: resolvedPath.canonicalAbsolutePath,
    });
  }
  return { mutationTargets };
}

export async function isApprovalPreflightCurrent(
  toolName: string,
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  args: Record<string, unknown>,
  expected: ApprovalPreflight,
): Promise<boolean> {
  const current = await collectPreflight(toolName, ctx, args);
  if (current === undefined) {
    return false;
  }
  return (
    current.mutationTargets.length === expected.mutationTargets.length &&
    current.mutationTargets.every((target, index) => {
      const expectedTarget = expected.mutationTargets[index];
      return (
        expectedTarget !== undefined &&
        target.argument === expectedTarget.argument &&
        target.canonicalTargetId === expectedTarget.canonicalTargetId
      );
    })
  );
}

export function shouldRequireApproval(
  toolName: string,
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
