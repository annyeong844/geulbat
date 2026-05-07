import { isProjectId, type ProjectId } from './ids.js';
import { isRecord, isString } from './runtime-utils.js';

export interface ProjectListItem {
  projectId: ProjectId;
  label: string;
}

export interface ProjectListResponse {
  defaultProjectId: ProjectId;
  projects: ProjectListItem[];
}

export interface CreateProjectRequest {
  label: string;
}

export interface RenameProjectRequest {
  label: string;
}

export type ProjectMutationResponse = ProjectListResponse;

export function getDefaultProjectRenameConflictMessage(): string {
  return 'Default project label is fixed and cannot be renamed.';
}

export function getDefaultProjectDeleteConflictMessage(): string {
  return 'Default project is kept in the registry and cannot be deleted.';
}

export function getSelectedProjectDeleteConflictMessage(): string {
  return 'Switch to another project before removing this project from the registry.';
}

export function getProjectRegistryDeleteDescription(): string {
  return 'Removing a project only unregisters it. Workspace files stay on disk.';
}

export function isProjectListResponse(
  value: unknown,
): value is ProjectListResponse {
  return (
    isRecord(value) &&
    isString(value.defaultProjectId) &&
    isProjectId(value.defaultProjectId) &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (project) =>
        isRecord(project) &&
        isString(project.projectId) &&
        isProjectId(project.projectId) &&
        isString(project.label),
    )
  );
}
