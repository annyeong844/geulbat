import {
  getFilesDefaultProjectDeleteConflictMessage as getDefaultProjectDeleteConflictMessage,
  getFilesDefaultProjectRenameConflictMessage as getDefaultProjectRenameConflictMessage,
  type ProjectId,
  type ProjectListItem,
} from './contract.js';
import { DEFAULT_PROJECT_ID } from './project-registry-state.js';

export type ProjectMutationAction = 'rename' | 'delete';

export function normalizeProjectLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error('label is required'), {
      code: 'bad_request',
    });
  }
  return trimmed;
}

export function assertProjectCanBeMutated(
  projectId: ProjectId,
  action: ProjectMutationAction,
): void {
  if (projectId !== DEFAULT_PROJECT_ID) {
    return;
  }

  throw Object.assign(
    new Error(
      action === 'rename'
        ? getDefaultProjectRenameConflictMessage()
        : getDefaultProjectDeleteConflictMessage(),
    ),
    {
      code: 'conflict',
    },
  );
}

export function findProjectIndexOrThrow(
  projects: readonly ProjectListItem[],
  projectId: ProjectId,
): number {
  const projectIndex = projects.findIndex(
    (project) => project.projectId === projectId,
  );
  if (projectIndex < 0) {
    throw Object.assign(new Error(`unknown projectId: ${projectId}`), {
      code: 'not_found',
    });
  }
  return projectIndex;
}
