import { resolve } from 'node:path';
import type { ProjectRegistryStore } from './project-registry-state.js';
import {
  ProjectRegistryCorruptionError,
  type ProjectRegistryFileStore,
} from './project-registry-file-store.js';

interface ProjectStoreBootstrapController {
  bootstrapProjectRegistry(repoRoot?: string): Promise<void>;
  reloadProjectRegistryFromDisk(): Promise<void>;
  assertProjectRegistryWritable(): void;
}

export function createProjectStoreBootstrapController(args: {
  projectRegistry: ProjectRegistryStore;
  fileStore: ProjectRegistryFileStore;
}): ProjectStoreBootstrapController {
  const { projectRegistry, fileStore } = args;
  let bootstrappedRoot: string | null = null;
  let bootstrappingRoot: string | null = null;
  let bootstrapPromise: Promise<void> | null = null;
  let projectRegistryCorruptionError: ProjectRegistryCorruptionError | null =
    null;

  async function reloadProjectRegistryFromDisk(): Promise<void> {
    try {
      const persistedProjects = await fileStore.readPersistedProjectRegistry(
        projectRegistry.getProjectRegistryRoot(),
      );
      projectRegistry.replaceProjectRegistry(persistedProjects);
      projectRegistryCorruptionError = null;
    } catch (error: unknown) {
      if (error instanceof ProjectRegistryCorruptionError) {
        projectRegistryCorruptionError = error;
      }
      throw error;
    }
  }

  function assertProjectRegistryWritable(): void {
    if (projectRegistryCorruptionError) {
      throw projectRegistryCorruptionError;
    }
  }

  function createBootstrapRootConflictError(
    currentRoot: string,
    nextRoot: string,
  ): Error {
    return Object.assign(
      new Error(
        `project registry already bootstrapped for ${currentRoot}; cannot rebootstrap with ${nextRoot}`,
      ),
      { code: 'conflict' as const },
    );
  }

  return {
    bootstrapProjectRegistry(
      repoRoot = projectRegistry.getProjectRegistryRoot(),
    ): Promise<void> {
      const nextRoot = resolve(repoRoot);
      if (bootstrappedRoot === nextRoot) {
        return Promise.resolve();
      }
      if (bootstrappedRoot !== null) {
        return Promise.reject(
          createBootstrapRootConflictError(bootstrappedRoot, nextRoot),
        );
      }
      if (bootstrapPromise !== null) {
        if (bootstrappingRoot === nextRoot) {
          return bootstrapPromise;
        }
        return Promise.reject(
          createBootstrapRootConflictError(
            bootstrappingRoot ?? 'unknown',
            nextRoot,
          ),
        );
      }

      bootstrappingRoot = nextRoot;
      bootstrapPromise = (async () => {
        try {
          const persistedProjects =
            await fileStore.readPersistedProjectRegistry(nextRoot);
          projectRegistry.configureProjectRegistryRoot(nextRoot);
          projectRegistry.replaceProjectRegistry(persistedProjects);
          projectRegistryCorruptionError = null;
          bootstrappedRoot = nextRoot;
        } catch (error: unknown) {
          if (error instanceof ProjectRegistryCorruptionError) {
            projectRegistryCorruptionError = error;
          }
          throw error;
        } finally {
          bootstrappingRoot = null;
          bootstrapPromise = null;
        }
      })();

      return bootstrapPromise;
    },
    reloadProjectRegistryFromDisk,
    assertProjectRegistryWritable,
  };
}
