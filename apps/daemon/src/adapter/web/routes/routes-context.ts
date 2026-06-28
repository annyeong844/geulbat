import type { ProjectId, RunId, ThreadId } from '@geulbat/protocol/ids';
import type { ProjectMutationResponse } from '@geulbat/protocol/projects';
import type { ProjectScopeRegistry } from '#web/request/project-scope.js';
import type { ProviderAuthCallbackServerController } from '../../../daemon/auth/bootstrap/callback-server.js';
import type { ProviderAuthBootstrapStore } from '../../../daemon/auth/bootstrap/session-store.js';
import type { ProviderAuthRuntimeStore } from '../../../daemon/auth/runtime-state.js';
import type { ProjectStore } from '../../../daemon/files/project-store.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';

export type ProjectRegistryLookup = ProjectScopeRegistry;

export interface ProjectRegistryContext {
  projectRegistry: ProjectRegistryLookup;
}

export interface ProjectStoreContext {
  projectStore: Pick<ProjectStore, 'snapshotProjectRegistry'>;
}

export interface ProjectScopedRoutesContext {
  projectRegistry: ProjectScopeRegistry;
}

export interface ProjectsRoutesContext {
  activeRuns: ActiveProjectRunLookup;
  projectStore: ProjectRouteStore;
  projectRegistry: ProjectRegistryLookup;
}

export interface ActiveProjectRunLookup {
  getRunByProjectId(
    projectId: ProjectId,
  ): { threadId: ThreadId; runId: RunId } | undefined;
}

export interface ProjectRouteStore {
  snapshotProjectRegistry(): ProjectMutationResponse;
  createProject(label: string): Promise<ProjectMutationResponse>;
  renameProject(
    projectId: ProjectId,
    label: string,
  ): Promise<ProjectMutationResponse>;
  deleteProject(projectId: ProjectId): Promise<ProjectMutationResponse>;
}

export interface ThreadsRoutesContext {
  activeRuns: ActiveThreadRunLookup;
  backgroundNotifications: Pick<
    BackgroundNotificationQueue,
    'clearThreadBackgroundResults'
  >;
  projectRegistry: ProjectRegistryLookup;
}

export interface ActiveThreadRunLookup {
  getRunByThreadId(threadId: string): { runId: RunId } | undefined;
}

export interface ProviderAuthRoutesContext {
  providerAuthBootstrap: ProviderAuthBootstrapStore;
  providerAuthCallbackServer: ProviderAuthCallbackServerController;
  providerAuthRuntime: ProviderAuthRuntimeStore;
}
