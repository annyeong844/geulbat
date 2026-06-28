import { resolve } from 'node:path';
import {
  DEFAULT_FILE_PROJECT_ID,
  type ProjectId,
  type ProjectListItem,
} from './contract.js';
import { readDefaultRepoRoot } from '../../repo-root.js';

interface ProjectRegistryEntry extends ProjectListItem {
  workspaceRoot: string;
}

export interface ProjectRegistryStore {
  getProjectRegistryRoot(): string;
  configureProjectRegistryRoot(root: string): void;
  getSeedProjects(): ProjectListItem[];
  getProjectRegistryEntries(): ProjectRegistryEntry[];
  replaceProjectRegistry(projects: readonly ProjectListItem[]): void;
  isKnownProjectId(projectId: string): projectId is ProjectId;
  listProjects(): ProjectListItem[];
  resolveProjectRoot(projectId: ProjectId): string | null;
}

const SEED_PROJECTS: readonly ProjectListItem[] = [
  {
    projectId: DEFAULT_FILE_PROJECT_ID,
    label: 'Workspace',
  },
  {
    projectId: 'manuscript' as ProjectId,
    label: 'Manuscript',
  },
];

const DEFAULT_PROJECT = SEED_PROJECTS[0];

if (!DEFAULT_PROJECT) {
  throw new Error('missing default seed project');
}

export const DEFAULT_PROJECT_ID = DEFAULT_PROJECT.projectId;

export function createProjectRegistryStore(args?: {
  root?: string;
}): ProjectRegistryStore {
  let projectRegistryRoot = resolve(args?.root ?? readDefaultRepoRoot());
  let projectRegistry = materializeProjectRegistryEntries(
    SEED_PROJECTS,
    projectRegistryRoot,
  );
  let projectMap = createProjectMap(projectRegistry);

  return {
    getProjectRegistryRoot() {
      return projectRegistryRoot;
    },
    configureProjectRegistryRoot(root) {
      const nextRoot = resolve(root);
      if (nextRoot === projectRegistryRoot) {
        return;
      }

      projectRegistryRoot = nextRoot;
      this.replaceProjectRegistry(projectRegistry.map(cloneProjectListItem));
    },
    getSeedProjects() {
      return SEED_PROJECTS.map(cloneProjectListItem);
    },
    getProjectRegistryEntries() {
      return projectRegistry.map((entry) => ({ ...entry }));
    },
    replaceProjectRegistry(projects) {
      projectRegistry = materializeProjectRegistryEntries(
        projects,
        projectRegistryRoot,
      );
      projectMap = createProjectMap(projectRegistry);
    },
    isKnownProjectId(projectId): projectId is ProjectId {
      return projectMap.has(projectId as ProjectId);
    },
    listProjects() {
      return projectRegistry.map(({ projectId, label }) => ({
        projectId,
        label,
      }));
    },
    resolveProjectRoot(projectId) {
      return projectMap.get(projectId)?.workspaceRoot ?? null;
    },
  };
}

function materializeProjectRegistryEntries(
  projects: readonly ProjectListItem[],
  projectRegistryRoot: string,
): ProjectRegistryEntry[] {
  return projects.map((project) => ({
    ...cloneProjectListItem(project),
    workspaceRoot: resolve(projectRegistryRoot, project.projectId),
  }));
}

function createProjectMap(
  registry: readonly ProjectRegistryEntry[],
): Map<ProjectId, ProjectRegistryEntry> {
  return new Map<ProjectId, ProjectRegistryEntry>(
    registry.map((entry) => [entry.projectId, entry]),
  );
}

function cloneProjectListItem(project: ProjectListItem): ProjectListItem {
  return {
    projectId: project.projectId,
    label: project.label,
  };
}
