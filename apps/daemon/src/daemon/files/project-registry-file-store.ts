import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProjectId, type ProjectId } from '@geulbat/protocol/ids';
import type { ProjectListItem } from '@geulbat/protocol/projects';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';
import { createLogger } from '@geulbat/shared-utils/logger';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { hasErrorCode, getErrorMessage } from '../utils/error.js';
import { joinWorkspaceGeulbatPath } from './geulbat-internal-paths.js';
import { DEFAULT_PROJECT_ID } from './project-registry-state.js';

const logger = createLogger('project-registry-file-store');

interface PersistedProjectRegistrySchema {
  version: 1;
  projects: ProjectListItem[];
}

export interface ProjectRegistryFileStore {
  getProjectMetadataDirForRoot(projectRegistryRoot: string): string;
  getProjectRegistryFilePathForRoot(projectRegistryRoot: string): string;
  readPersistedProjectRegistry(
    projectRegistryRoot: string,
  ): Promise<ProjectListItem[]>;
  persistProjectRegistry(
    projectRegistryRoot: string,
    projects: readonly ProjectListItem[],
  ): Promise<void>;
}

export class ProjectRegistryCorruptionError extends Error {
  code = 'corrupt_project_registry_metadata' as const;
  filePath: string;

  constructor(filePath: string, reason: string) {
    super(`project registry metadata is corrupted: ${filePath} (${reason})`);
    this.name = 'ProjectRegistryCorruptionError';
    this.filePath = filePath;
  }
}

export function createProjectRegistryFileStore(args: {
  getSeedProjects: () => ProjectListItem[];
}): ProjectRegistryFileStore {
  function getProjectMetadataDirForRoot(projectRegistryRoot: string): string {
    return joinWorkspaceGeulbatPath(projectRegistryRoot);
  }

  function getProjectRegistryFilePathForRoot(
    projectRegistryRoot: string,
  ): string {
    return join(
      getProjectMetadataDirForRoot(projectRegistryRoot),
      'projects.json',
    );
  }

  return {
    getProjectMetadataDirForRoot,
    getProjectRegistryFilePathForRoot,
    async readPersistedProjectRegistry(projectRegistryRoot) {
      const filePath = getProjectRegistryFilePathForRoot(projectRegistryRoot);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT')) {
          return args.getSeedProjects();
        }
        throw error;
      }

      try {
        const data: unknown = JSON.parse(raw);
        return parsePersistedProjectRegistry(data, args.getSeedProjects());
      } catch (error: unknown) {
        const corruptionError = new ProjectRegistryCorruptionError(
          filePath,
          getErrorMessage(error),
        );
        logger.error(corruptionError.message);
        throw corruptionError;
      }
    },
    async persistProjectRegistry(projectRegistryRoot, projects) {
      const payload: PersistedProjectRegistrySchema = {
        version: 1,
        projects: projects.map((project) => ({
          projectId: project.projectId,
          label: project.label,
        })),
      };

      await mkdir(getProjectMetadataDirForRoot(projectRegistryRoot), {
        recursive: true,
      });
      await writeTextFileAtomically(
        getProjectRegistryFilePathForRoot(projectRegistryRoot),
        JSON.stringify(payload, null, 2) + '\n',
      );
    },
  };
}

function parsePersistedProjectRegistry(
  value: unknown,
  seedProjects: ProjectListItem[],
): ProjectListItem[] {
  if (!isPlainRecord(value)) {
    throw new Error('invalid project registry metadata');
  }

  const record = value;
  if (record['version'] !== 1 || !Array.isArray(record['projects'])) {
    throw new Error('invalid project registry metadata');
  }

  const projects = record['projects'].map(parsePersistedProjectListItem);
  const uniqueProjectIds = new Set<string>();
  for (const project of projects) {
    if (uniqueProjectIds.has(project.projectId)) {
      throw new Error('duplicate projectId in project registry metadata');
    }
    uniqueProjectIds.add(project.projectId);
  }

  if (!uniqueProjectIds.has(DEFAULT_PROJECT_ID)) {
    const defaultProject = seedProjects[0];
    if (!defaultProject) {
      throw new Error('missing default project seed');
    }
    return [defaultProject, ...projects];
  }

  return projects;
}

function parsePersistedProjectListItem(value: unknown): ProjectListItem {
  if (!isPlainRecord(value)) {
    throw new Error('invalid project registry entry');
  }

  const record = value;
  const projectId = record['projectId'];
  const label = record['label'];
  if (
    typeof projectId !== 'string' ||
    !isProjectId(projectId) ||
    typeof label !== 'string' ||
    label.trim() === ''
  ) {
    throw new Error('invalid project registry entry');
  }

  return {
    projectId: projectId as ProjectId,
    label: label.trim(),
  };
}
