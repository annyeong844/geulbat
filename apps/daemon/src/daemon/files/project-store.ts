import type {
  ProjectId,
  ProjectListItem,
  ProjectMutationResponse,
} from './contract.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import { deriveProjectId } from './project-id-slug.js';
import {
  assertProjectCanBeMutated,
  findProjectIndexOrThrow,
  normalizeProjectLabel,
} from './project-mutation-policy.js';
import { ensureProjectRootDirectory } from './project-root-materialization.js';
import {
  DEFAULT_PROJECT_ID,
  type ProjectRegistryStore,
} from './project-registry-state.js';
import {
  createProjectRegistryFileStore,
  ProjectRegistryCorruptionError,
} from './project-registry-file-store.js';
import { createProjectStoreBootstrapController } from './project-store-bootstrap.js';

const runProjectRegistryMutationSerial = createKeyedSerialRunner();

export interface ProjectStore {
  getProjectRegistryFilePath(): string;
  bootstrapProjectRegistry(repoRoot?: string): Promise<void>;
  reloadProjectRegistryFromDisk(): Promise<void>;
  snapshotProjectRegistry(): ProjectMutationResponse;
  createProject(label: string): Promise<ProjectMutationResponse>;
  renameProject(
    projectId: ProjectId,
    label: string,
  ): Promise<ProjectMutationResponse>;
  deleteProject(projectId: ProjectId): Promise<ProjectMutationResponse>;
}

export { ProjectRegistryCorruptionError };

export function createProjectStore(args: {
  projectRegistry: ProjectRegistryStore;
}): ProjectStore {
  const { projectRegistry } = args;
  const fileStore = createProjectRegistryFileStore({
    getSeedProjects: () => projectRegistry.getSeedProjects(),
  });
  const bootstrapController = createProjectStoreBootstrapController({
    projectRegistry,
    fileStore,
  });

  function getProjectRegistryFilePath(): string {
    return fileStore.getProjectRegistryFilePathForRoot(
      projectRegistry.getProjectRegistryRoot(),
    );
  }

  function listProjects(): ProjectListItem[] {
    return projectRegistry.listProjects();
  }

  function snapshotProjectRegistry(
    projects: readonly ProjectListItem[] = listProjects(),
  ): ProjectMutationResponse {
    return {
      defaultProjectId: DEFAULT_PROJECT_ID,
      projects: projects.map((project) => ({
        projectId: project.projectId,
        label: project.label,
      })),
    };
  }

  async function persistProjectRegistry(
    projects: readonly ProjectListItem[],
  ): Promise<void> {
    await fileStore.persistProjectRegistry(
      projectRegistry.getProjectRegistryRoot(),
      projects,
    );
  }

  async function persistAndReplaceProjectRegistry(
    projects: readonly ProjectListItem[],
  ): Promise<ProjectMutationResponse> {
    await persistProjectRegistry(projects);
    projectRegistry.replaceProjectRegistry(projects);
    return snapshotProjectRegistry(projects);
  }

  async function mutateProjectRegistry(
    mutate: (
      projects: ProjectListItem[],
    ) => Promise<ProjectMutationResponse> | ProjectMutationResponse,
  ): Promise<ProjectMutationResponse> {
    return runProjectRegistryMutationSerial(
      getProjectRegistryFilePath(),
      async () => {
        bootstrapController.assertProjectRegistryWritable();
        return mutate(listProjects());
      },
    );
  }

  return {
    getProjectRegistryFilePath,
    bootstrapProjectRegistry: bootstrapController.bootstrapProjectRegistry,
    reloadProjectRegistryFromDisk:
      bootstrapController.reloadProjectRegistryFromDisk,
    snapshotProjectRegistry,
    async createProject(label) {
      return mutateProjectRegistry(async (currentProjects) => {
        const nextLabel = normalizeProjectLabel(label);
        const nextProjectId = deriveProjectId(
          nextLabel,
          new Set(currentProjects.map((project) => project.projectId)),
        );

        await ensureProjectRootDirectory({
          projectId: nextProjectId,
          projectRegistryRoot: projectRegistry.getProjectRegistryRoot(),
          resolveProjectRoot: (projectId) =>
            projectRegistry.resolveProjectRoot(projectId),
        });

        return persistAndReplaceProjectRegistry([
          ...currentProjects,
          { projectId: nextProjectId, label: nextLabel },
        ]);
      });
    },
    async renameProject(projectId, label) {
      return mutateProjectRegistry(async (currentProjects) => {
        assertProjectCanBeMutated(projectId, 'rename');
        const nextLabel = normalizeProjectLabel(label);
        const projectIndex = findProjectIndexOrThrow(
          currentProjects,
          projectId,
        );
        const currentProject = currentProjects[projectIndex];
        if (!currentProject) {
          throw new Error(`missing project at index: ${projectIndex}`);
        }
        if (currentProject.label === nextLabel) {
          return snapshotProjectRegistry(currentProjects);
        }

        const nextProjects = currentProjects.slice();
        nextProjects[projectIndex] = {
          projectId: currentProject.projectId,
          label: nextLabel,
        };
        return persistAndReplaceProjectRegistry(nextProjects);
      });
    },
    async deleteProject(projectId) {
      return mutateProjectRegistry(async (currentProjects) => {
        assertProjectCanBeMutated(projectId, 'delete');
        const projectIndex = findProjectIndexOrThrow(
          currentProjects,
          projectId,
        );
        const nextProjects = currentProjects.slice();
        nextProjects.splice(projectIndex, 1);
        return persistAndReplaceProjectRegistry(nextProjects);
      });
    },
  };
}
