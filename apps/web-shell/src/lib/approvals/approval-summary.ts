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
    case 'patch_file':
      return {
        title: path ? `Patch ${path}` : 'Patch file',
        detail: buildPatchDetail(args),
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

function buildPatchDetail(
  args: ApprovalRequired['argumentsPreview'],
): string | null {
  const oldString = readStringArg(args, 'old_string');
  const newString = readStringArg(args, 'new_string');
  if (!oldString && !newString) {
    return null;
  }
  if (!oldString) {
    return 'Append patch';
  }
  if (!newString) {
    return 'Remove matching text';
  }
  return 'Replace matching text';
}
