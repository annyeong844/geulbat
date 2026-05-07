import {
  isThreadId,
  type ProjectId,
  type ThreadId,
} from '@geulbat/protocol/ids';

import {
  readRequiredBodyString,
  readRequiredQueryString,
} from './string-fields.js';

type RouteScopeError = {
  ok: false;
  code: 'bad_request' | 'not_found';
  message: string;
};

type ProjectWorkspaceScope = {
  ok: true;
  projectId: ProjectId;
  workspaceRoot: string;
};

export interface ProjectScopeRegistry {
  isKnownProjectId(projectId: string): boolean;
  resolveProjectRoot(projectId: string): string | null;
}

export function readProjectWorkspaceScope(
  value: unknown,
  args: { projectRegistry: ProjectScopeRegistry },
): ProjectWorkspaceScope | RouteScopeError {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, code: 'bad_request', message: 'projectId is required' };
  }

  return resolveProjectWorkspaceScope(value, args);
}

export function readProjectWorkspaceScopeFromQuery(
  value: unknown,
  args: { projectRegistry: ProjectScopeRegistry },
): ProjectWorkspaceScope | RouteScopeError {
  const projectIdResult = readRequiredQueryString(value, 'projectId');
  if (!projectIdResult.ok) {
    return {
      ok: false,
      code: 'bad_request',
      message: projectIdResult.message,
    };
  }

  return resolveProjectWorkspaceScope(projectIdResult.value, args);
}

export function readProjectWorkspaceScopeFromBody(
  body: Record<string, unknown> | undefined,
  args: { projectRegistry: ProjectScopeRegistry },
): ProjectWorkspaceScope | RouteScopeError {
  const projectIdResult = readRequiredBodyString(body, 'projectId');
  if (!projectIdResult.ok) {
    return {
      ok: false,
      code: 'bad_request',
      message: projectIdResult.message,
    };
  }

  return resolveProjectWorkspaceScope(projectIdResult.value, args);
}

export function readProjectIdParam(
  value: unknown,
  args: { projectRegistry: ProjectScopeRegistry },
): { ok: true; value: ProjectId } | RouteScopeError {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, code: 'bad_request', message: 'projectId is required' };
  }
  const { projectRegistry } = args;
  if (!projectRegistry.isKnownProjectId(value)) {
    return {
      ok: false,
      code: 'not_found',
      message: `unknown projectId: ${value}`,
    };
  }
  return { ok: true, value: value as ProjectId };
}

export function readThreadIdParam(
  value: unknown,
): { ok: true; value: ThreadId } | RouteScopeError {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, code: 'bad_request', message: 'threadId is required' };
  }
  if (!isThreadId(value)) {
    return { ok: false, code: 'bad_request', message: 'invalid threadId' };
  }
  return { ok: true, value };
}

function resolveProjectWorkspaceScope(
  projectId: string,
  args: { projectRegistry: ProjectScopeRegistry },
): ProjectWorkspaceScope | RouteScopeError {
  const { projectRegistry } = args;
  if (!projectRegistry.isKnownProjectId(projectId)) {
    return {
      ok: false,
      code: 'not_found',
      message: `unknown projectId: ${projectId}`,
    };
  }

  const workspaceRoot = projectRegistry.resolveProjectRoot(projectId);
  if (!workspaceRoot) {
    return {
      ok: false,
      code: 'not_found',
      message: `cannot resolve projectId: ${projectId}`,
    };
  }

  return { ok: true, projectId: projectId as ProjectId, workspaceRoot };
}
