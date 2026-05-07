import type {
  CreateProjectRequest,
  ProjectListResponse,
  ProjectMutationResponse,
  RenameProjectRequest,
} from '@geulbat/protocol/projects';
import { isProjectListResponse } from '@geulbat/protocol/projects';

import { apiFetch } from './client.js';

export function getProjects(): Promise<ProjectListResponse> {
  return apiFetch('/api/projects', undefined, isProjectListResponse);
}

export function createProject(
  request: CreateProjectRequest,
): Promise<ProjectMutationResponse> {
  return apiFetch(
    '/api/projects',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isProjectListResponse,
  );
}

export function renameProject(
  projectId: string,
  request: RenameProjectRequest,
): Promise<ProjectMutationResponse> {
  return apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isProjectListResponse,
  );
}

export function deleteProject(
  projectId: string,
): Promise<ProjectMutationResponse> {
  return apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: 'DELETE',
    },
    isProjectListResponse,
  );
}
