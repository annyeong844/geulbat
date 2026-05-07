import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readFile as fsReadFile,
  rm,
  stat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import {
  assertThreadId as assertValidThreadId,
  type ProjectId,
} from '@geulbat/protocol/ids';
import {
  getDefaultProjectDeleteConflictMessage,
  getDefaultProjectRenameConflictMessage,
} from '@geulbat/protocol/projects';

import { DEFAULT_PROJECT_ID } from './daemon/files/project-registry-state.js';
import type { ProjectStore } from './daemon/files/project-store.js';
import { hasErrorCode } from './daemon/utils/error.js';
import { bootstrapDaemonContext } from './bootstrap-daemon-context.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  getSecondaryProjectIdFromContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { testRunId } from './test-support/run-id.js';

void test('authenticated projects route returns canonical registry', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: authHeaders(),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        defaultProjectId: string;
        projects: Array<{ projectId: string; label: string }>;
      };

      assert.equal(body.defaultProjectId, DEFAULT_PROJECT_ID);
      assert.deepEqual(
        body.projects,
        daemonContext.projectStore.snapshotProjectRegistry().projects,
      );
      assert.ok(body.projects.length >= 2);
    },
    { daemonContext },
  );
});

void test('authenticated projects create route persists new registry entry and root', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
    const label = `Route Novel ${randomUUID().slice(0, 8)}`;
    let createdRoot: string | null = null;

    try {
      await withAuthenticatedDaemonServer(
        async ({ port }) => {
          const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ label }),
          });

          assert.equal(res.status, 201);
          const body = (await res.json()) as {
            defaultProjectId: string;
            projects: Array<{ projectId: string; label: string }>;
          };

          const createdProject = body.projects.find(
            (project) => project.label === label,
          );
          assert.ok(
            createdProject,
            'created project must be present in snapshot',
          );

          createdRoot = getWorkspaceRootFromContext(
            daemonContext,
            createdProject.projectId as ProjectId,
          );
          assert.equal(await pathExists(createdRoot), true);

          const registryBody = JSON.parse(
            await fsReadFile(
              daemonContext.projectStore.getProjectRegistryFilePath(),
              'utf8',
            ),
          ) as {
            version: number;
            projects: Array<{ projectId: string; label: string }>;
          };
          assert.equal(registryBody.version, 1);
          assert.equal(
            registryBody.projects.some(
              (project) =>
                project.projectId === createdProject.projectId &&
                project.label === label,
            ),
            true,
          );
        },
        { daemonContext },
      );
    } finally {
      if (createdRoot) {
        await rm(createdRoot, { recursive: true, force: true });
      }
    }
  });
});

void test('authenticated projects rename route updates label without changing project id', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
    const createLabel = `Rename Slice ${randomUUID().slice(0, 8)}`;
    const renameLabel = `Renamed Slice ${randomUUID().slice(0, 8)}`;
    let createdRoot: string | null = null;

    try {
      await withAuthenticatedDaemonServer(
        async ({ port }) => {
          const createRes = await fetch(
            `http://127.0.0.1:${port}/api/projects`,
            {
              method: 'POST',
              headers: authHeaders({
                'Content-Type': 'application/json',
              }),
              body: JSON.stringify({ label: createLabel }),
            },
          );
          assert.equal(createRes.status, 201);
          const createBody = (await createRes.json()) as {
            projects: Array<{ projectId: string; label: string }>;
          };

          const createdProject = createBody.projects.find(
            (project) => project.label === createLabel,
          );
          assert.ok(createdProject, 'created project must exist before rename');

          createdRoot = getWorkspaceRootFromContext(
            daemonContext,
            createdProject.projectId as ProjectId,
          );

          const renameRes = await fetch(
            `http://127.0.0.1:${port}/api/projects/${createdProject.projectId}`,
            {
              method: 'PATCH',
              headers: authHeaders({
                'Content-Type': 'application/json',
              }),
              body: JSON.stringify({ label: renameLabel }),
            },
          );

          assert.equal(renameRes.status, 200);
          const renameBody = (await renameRes.json()) as {
            projects: Array<{ projectId: string; label: string }>;
          };
          assert.equal(
            renameBody.projects.some(
              (project) =>
                project.projectId === createdProject.projectId &&
                project.label === renameLabel,
            ),
            true,
          );
          assert.equal(
            getWorkspaceRootFromContext(
              daemonContext,
              createdProject.projectId as ProjectId,
            ),
            createdRoot,
          );
        },
        { daemonContext },
      );
    } finally {
      if (createdRoot) {
        await rm(createdRoot, { recursive: true, force: true });
      }
    }
  });
});

void test('authenticated projects rename route rejects default project', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/projects/${DEFAULT_PROJECT_ID}`,
          {
            method: 'PATCH',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ label: 'Renamed Workspace' }),
          },
        );

        assert.equal(res.status, 409);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'conflict');
        assert.equal(body.message, getDefaultProjectRenameConflictMessage());
      },
      { daemonContext },
    );
  });
});

void test('authenticated projects delete route unregisters non-default project without wiping root', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
    const label = `Delete Slice ${randomUUID().slice(0, 8)}`;
    let createdProjectId: ProjectId | null = null;
    let createdRoot: string | null = null;

    try {
      await withAuthenticatedDaemonServer(
        async ({ port }) => {
          const createRes = await fetch(
            `http://127.0.0.1:${port}/api/projects`,
            {
              method: 'POST',
              headers: authHeaders({
                'Content-Type': 'application/json',
              }),
              body: JSON.stringify({ label }),
            },
          );
          assert.equal(createRes.status, 201);
          const createBody = (await createRes.json()) as {
            projects: Array<{ projectId: string; label: string }>;
          };

          const createdProject = createBody.projects.find(
            (project) => project.label === label,
          );
          assert.ok(createdProject, 'created project must exist before delete');

          createdProjectId = createdProject.projectId as ProjectId;
          createdRoot = getWorkspaceRootFromContext(
            daemonContext,
            createdProjectId,
          );

          const deleteRes = await fetch(
            `http://127.0.0.1:${port}/api/projects/${createdProject.projectId}`,
            {
              method: 'DELETE',
              headers: authHeaders(),
            },
          );

          assert.equal(deleteRes.status, 200);
          const deleteBody = (await deleteRes.json()) as {
            projects: Array<{ projectId: string; label: string }>;
          };
          assert.equal(
            deleteBody.projects.some(
              (project) => project.projectId === createdProject.projectId,
            ),
            false,
          );
          assert.equal(await pathExists(createdRoot), true);
        },
        { daemonContext },
      );
    } finally {
      if (createdRoot) {
        await rm(createdRoot, { recursive: true, force: true });
      }
      if (createdProjectId) {
        assert.equal(
          daemonContext.activeRuns.getRunByProjectId(createdProjectId),
          undefined,
        );
      }
    }
  });
});

void test('authenticated projects delete route rejects default project', async () => {
  const daemonContext = createRouteTestDaemonContext();
  await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/projects/${DEFAULT_PROJECT_ID}`,
          {
            method: 'DELETE',
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 409);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'conflict');
        assert.equal(body.message, getDefaultProjectDeleteConflictMessage());
      },
      { daemonContext },
    );
  });
});

void test('authenticated projects delete route rejects active-run projects', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const projectId = getSecondaryProjectIdFromContext(daemonContext);
  const threadId = assertValidThreadId(randomUUID());
  const runId = testRunId('project-delete-conflict');
  const abortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(threadId, {
      runId,
      threadId,
      projectId,
      workspaceRoot: getWorkspaceRootFromContext(daemonContext, projectId),
      ownerThreadId: threadId,
      abortController,
      startedAt: '2026-03-28T00:00:00.000Z',
    }),
    { ok: true },
  );

  try {
    await withProjectRegistrySnapshot(daemonContext.projectStore, async () => {
      await withAuthenticatedDaemonServer(
        async ({ port }) => {
          const res = await fetch(
            `http://127.0.0.1:${port}/api/projects/${projectId}`,
            {
              method: 'DELETE',
              headers: authHeaders(),
            },
          );

          assert.equal(res.status, 409);
          const body = (await res.json()) as {
            code: string;
            message: string;
            projectId?: string;
            threadId?: string;
            activeRunId?: string;
          };
          assert.equal(body.code, 'conflict_active_run');
          assert.equal(body.projectId, projectId);
          assert.equal(body.threadId, threadId);
          assert.equal(body.activeRunId, runId);
          assert.match(body.message, /active run/i);
        },
        { daemonContext },
      );
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
  }
});

async function withProjectRegistrySnapshot<T>(
  projectStore: Pick<
    ProjectStore,
    | 'bootstrapProjectRegistry'
    | 'getProjectRegistryFilePath'
    | 'reloadProjectRegistryFromDisk'
  >,
  run: () => Promise<T>,
): Promise<T> {
  await bootstrapDaemonContext({
    projectStore,
  });
  const registryFilePath = projectStore.getProjectRegistryFilePath();
  const registrySnapshot = await snapshotFile(registryFilePath);
  try {
    return await run();
  } finally {
    await restoreFileSnapshot(registryFilePath, registrySnapshot);
    await projectStore.reloadProjectRegistryFromDisk();
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function snapshotFile(
  filePath: string,
): Promise<{ exists: boolean; content: string | null }> {
  try {
    return {
      exists: true,
      content: await fsReadFile(filePath, 'utf8'),
    };
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { exists: false, content: null };
    }
    throw error;
  }
}

async function restoreFileSnapshot(
  filePath: string,
  snapshot: { exists: boolean; content: string | null },
): Promise<void> {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }

  await fsWriteFile(filePath, snapshot.content ?? '', 'utf8');
}
