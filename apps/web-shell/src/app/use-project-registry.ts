import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { DEFAULT_PROJECT_ID, type ProjectId } from '@geulbat/protocol/ids';
import type {
  ProjectListItem,
  ProjectListResponse,
} from '@geulbat/protocol/projects';
import {
  getDefaultProjectDeleteConflictMessage,
  getDefaultProjectRenameConflictMessage,
  getSelectedProjectDeleteConflictMessage,
} from '@geulbat/protocol/projects';

import {
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  getProjects,
  renameProject as renameProjectRequest,
} from '../lib/api/projects.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { reportVisibleAppError } from './error-reporting.js';

const logger = createLogger('project-registry');

interface ReportProjectRegistryErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

interface UseProjectMutationsArgs {
  defaultProjectId: ProjectId;
  selectedProjectId: ProjectId;
  applyProjectSnapshot: (response: ProjectListResponse) => void;
  setProjectError: Dispatch<SetStateAction<string | null>>;
}

interface ProjectMutations {
  mutationBusy: boolean;
  addProject: (label: string) => Promise<boolean>;
  renameProject: (projectId: string, label: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<boolean>;
}

const FALLBACK_PROJECTS: ProjectListItem[] = [
  {
    projectId: DEFAULT_PROJECT_ID,
    label: 'Workspace',
  },
];

function reportProjectRegistryError({
  logContext,
  visiblePrefix,
  error,
}: ReportProjectRegistryErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

function useProjectMutations({
  defaultProjectId,
  selectedProjectId,
  applyProjectSnapshot,
  setProjectError,
}: UseProjectMutationsArgs): ProjectMutations {
  const [mutationBusy, setMutationBusy] = useState(false);

  const mutateAndSync = useCallback(
    async (
      mutation: () => Promise<ProjectListResponse>,
      visiblePrefix: string,
    ): Promise<boolean> => {
      setMutationBusy(true);
      try {
        const response = await mutation();
        applyProjectSnapshot(response);
        setProjectError(null);
        return true;
      } catch (err: unknown) {
        setProjectError(
          reportProjectRegistryError({
            logContext: 'project registry mutation failed',
            visiblePrefix,
            error: err,
          }),
        );
        return false;
      } finally {
        setMutationBusy(false);
      }
    },
    [applyProjectSnapshot, setProjectError],
  );

  const addProject = useCallback(
    async (label: string): Promise<boolean> => {
      const trimmed = label.trim();
      if (trimmed.length === 0) {
        setProjectError('Project label is required.');
        return false;
      }

      return mutateAndSync(
        () => createProjectRequest({ label: trimmed }),
        'Unable to add project.',
      );
    },
    [mutateAndSync, setProjectError],
  );

  const renameProject = useCallback(
    async (projectId: string, label: string): Promise<boolean> => {
      if (projectId === defaultProjectId) {
        setProjectError(getDefaultProjectRenameConflictMessage());
        return false;
      }

      const trimmed = label.trim();
      if (trimmed.length === 0) {
        setProjectError('Project label is required.');
        return false;
      }

      return mutateAndSync(
        () => renameProjectRequest(projectId, { label: trimmed }),
        'Unable to rename project.',
      );
    },
    [defaultProjectId, mutateAndSync, setProjectError],
  );

  const deleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (projectId === defaultProjectId) {
        setProjectError(getDefaultProjectDeleteConflictMessage());
        return false;
      }
      if (projectId === selectedProjectId) {
        setProjectError(getSelectedProjectDeleteConflictMessage());
        return false;
      }

      return mutateAndSync(
        () => deleteProjectRequest(projectId),
        'Unable to delete project.',
      );
    },
    [defaultProjectId, mutateAndSync, selectedProjectId, setProjectError],
  );

  return {
    mutationBusy,
    addProject,
    renameProject,
    deleteProject,
  };
}

export function useProjectRegistry() {
  const [defaultProjectId, setDefaultProjectId] =
    useState<ProjectId>(DEFAULT_PROJECT_ID);
  const [projects, setProjects] =
    useState<ProjectListItem[]>(FALLBACK_PROJECTS);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] =
    useState<ProjectId>(DEFAULT_PROJECT_ID);

  const applyProjectSnapshot = useCallback((response: ProjectListResponse) => {
    setProjects(response.projects);
    setDefaultProjectId(response.defaultProjectId);
    setSelectedProjectId((current) =>
      response.projects.some((project) => project.projectId === current)
        ? current
        : response.defaultProjectId,
    );
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const response = await getProjects();
      applyProjectSnapshot(response);
      setProjectError(null);
    } catch (err: unknown) {
      setProjectError(
        reportProjectRegistryError({
          logContext: 'loadProjects failed',
          visiblePrefix: 'Unable to load project list.',
          error: err,
        }),
      );
    }
  }, [applyProjectSnapshot]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const projectsById = useMemo<ReadonlyMap<string, ProjectListItem>>(
    () =>
      new Map(
        projects.map((project): [string, ProjectListItem] => [
          project.projectId,
          project,
        ]),
      ),
    [projects],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      const nextProject = projectsById.get(projectId);
      if (!nextProject) {
        return;
      }

      setSelectedProjectId(nextProject.projectId);
      setProjectError(null);
    },
    [projectsById],
  );
  const { mutationBusy, addProject, renameProject, deleteProject } =
    useProjectMutations({
      defaultProjectId,
      selectedProjectId,
      applyProjectSnapshot,
      setProjectError,
    });

  return {
    defaultProjectId,
    projects,
    projectError,
    selectedProjectId,
    mutationBusy,
    selectProject,
    addProject,
    renameProject,
    deleteProject,
  };
}
