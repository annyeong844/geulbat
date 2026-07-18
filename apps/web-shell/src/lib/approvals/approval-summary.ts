import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import {
  isWellKnownApprovalClass,
  type WellKnownApprovalClass,
} from '@geulbat/protocol/run-approval';

interface ApprovalSummary {
  title: string;
  detail: string | null;
}

export function buildApprovalSummary(
  pending: ApprovalRequired,
): ApprovalSummary {
  if (!isWellKnownApprovalClass(pending.approvalClass)) {
    const path = readStringArg(pending.argumentsPreview, 'path');
    return {
      title: `Run ${pending.toolName}`,
      detail: path,
    };
  }

  return buildWellKnownApprovalSummary(pending, pending.approvalClass);
}

function buildWellKnownApprovalSummary(
  pending: ApprovalRequired,
  approvalClass: WellKnownApprovalClass,
): ApprovalSummary {
  const args = pending.argumentsPreview;
  const path = readStringArg(args, 'path');
  const destination = readStringArg(args, 'destination');

  switch (approvalClass) {
    case 'write_file':
      return {
        title: path ? `Write ${path}` : 'Write file',
        detail: buildContentDetail(args),
      };
    case 'apply_patch':
      return {
        title: buildApplyPatchTitle(args),
        detail: buildApplyPatchDetail(args),
      };
    case 'manage_files:create':
      return {
        title: path ? `Create ${path}` : 'Create file',
        detail: null,
      };
    case 'manage_files:rename':
      return {
        title:
          path && destination
            ? `Rename ${path} -> ${destination}`
            : 'Rename path',
        detail: null,
      };
    case 'manage_files:move':
      return {
        title:
          path && destination ? `Move ${path} -> ${destination}` : 'Move path',
        detail: null,
      };
    case 'manage_files:mkdir':
      return {
        title: path ? `Create folder ${path}` : 'Create folder',
        detail: null,
      };
    case 'manage_files:delete':
      return {
        title: path ? `Delete ${path}` : 'Delete path',
        detail: null,
      };
    case 'manage_files':
      return {
        title: path ? `Manage ${path}` : 'Manage path',
        detail: null,
      };
    case 'refresh_memory_index':
      return {
        title: 'Rebuild workspace memory index',
        detail: null,
      };
    case 'exec_command':
      return {
        title: 'Run shell command',
        detail: readStringArg(args, 'cmd'),
      };
  }
}

function readStringArg(
  args: ApprovalRequired['argumentsPreview'],
  key: string,
): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function buildContentDetail(
  args: ApprovalRequired['argumentsPreview'],
): string | null {
  const content = readStringArg(args, 'content');
  if (!content) {
    return null;
  }
  const lineCount = content === '' ? 0 : content.split('\n').length;
  return `${lineCount} line${lineCount === 1 ? '' : 's'} of content`;
}

function buildApplyPatchTitle(
  args: ApprovalRequired['argumentsPreview'],
): string {
  const patch = readStringArg(args, 'patch');
  const target = patch ? readApplyPatchTarget(patch) : null;
  return target ? `Apply patch to ${target}` : 'Apply patch';
}

function buildApplyPatchDetail(
  args: ApprovalRequired['argumentsPreview'],
): string | null {
  const patch = readStringArg(args, 'patch');
  if (!patch) {
    return null;
  }
  if (patch.includes('\n*** Add File: ')) {
    return 'Add file';
  }
  if (patch.includes('\n*** Delete File: ')) {
    return 'Unsupported delete patch';
  }
  if (patch.includes('\n*** Update File: ')) {
    return 'Update file';
  }
  return 'Patch text';
}

function readApplyPatchTarget(patch: string): string | null {
  const targetPrefixes = [
    '*** Add File: ',
    '*** Update File: ',
    '*** Delete File: ',
  ];
  for (const line of patch.split('\n')) {
    for (const prefix of targetPrefixes) {
      if (line.startsWith(prefix)) {
        const target = line.slice(prefix.length).trim();
        return target.length > 0 ? target : null;
      }
    }
  }
  return null;
}
