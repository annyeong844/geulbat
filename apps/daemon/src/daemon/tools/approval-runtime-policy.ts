import { toApprovalClass } from '@geulbat/protocol/run-approval';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { resolveSourceMutationTarget } from '../files/file-platform.js';
import { parseSingleApplyPatchTargetPath } from './builtin/apply-patch-parser.js';
import { resolveComputerFileToolPath } from './file-tool-root.js';
import type { ToolMetaReader } from './tool-registry-model.js';
import type {
  ApprovalGrantStore,
  ApprovalClass,
  ApprovalGrantContext,
} from './approval-grants.js';

interface ApprovalPreflightTarget {
  argument: 'path' | 'destination' | 'patch';
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

/**
 * 이 호출에 걸릴 승낙(grant)의 클래스.
 *
 * 도구가 선언한 클래스가 있으면 그것이 답이다. 없으면 도구 이름이 곧
 * 클래스인데, 그것은 규칙이 아니라 내장 도구들이 우연히 슬러그 이름을 가진
 * 결과다 — 그래서 레지스트리를 **선택이 아니라 필수**로 받는다. 선택으로
 * 두면 호출자가 빠뜨렸을 때 조용히 이름 유도로 떨어지고, 이름이 슬러그가
 * 아닌 도구(MCP 투영 이름 등)에서 런타임에 터진다. 컴파일 시점에 잡는 편이
 * 낫다.
 */
export function resolveApprovalClass(
  toolName: string,
  args: Record<string, unknown> | undefined,
  options: { toolRegistry: ToolMetaReader },
): ApprovalClass {
  const declared = options.toolRegistry.getToolMeta(toolName)?.approvalClass;
  if (declared !== undefined) {
    return declared;
  }
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

  // 전체 액세스는 말 그대로 전부 자동 승인한다 — 위험 수용은 모드를 켜는
  // 시점(⚠ 표시)에 이미 이루어졌고, 매 호출 재확인은 소유자 결정으로 제거
  // (2026-07-12). 효과 수준 조건도 제거 (오너 결정 2026-07-23): yolo 모드는
  // 수준/메타 유무와 무관하게 승인창을 띄우지 않는다. basic 모드는 여전히
  // write/destructive 모두 승인창을 띄운다.
  return approvalGrantContext.permissionMode === 'full_access';
}

export async function collectPreflight(
  toolName: string,
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  args: Record<string, unknown>,
): Promise<ApprovalPreflight | undefined> {
  const preflightPaths: Array<{
    argument: ApprovalPreflightTarget['argument'];
    inputPath: string;
  }> = [];
  if (toolName === 'apply_patch') {
    const patch = args.patch;
    if (typeof patch === 'string') {
      preflightPaths.push({
        argument: 'patch',
        inputPath: parseSingleApplyPatchTargetPath(patch),
      });
    }
  } else {
    const preflightArguments = COMPUTER_FILE_PREFLIGHT_ARGUMENTS.get(toolName);
    if (preflightArguments === undefined) {
      return undefined;
    }
    for (const argument of preflightArguments) {
      const inputPath = args[argument];
      if (typeof inputPath === 'string') {
        preflightPaths.push({ argument, inputPath });
      }
    }
  }

  const mutationTargets: ApprovalPreflightTarget[] = [];
  for (const { argument, inputPath } of preflightPaths) {
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
