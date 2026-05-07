import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createProjectStore,
  ProjectRegistryCorruptionError,
  type ProjectStore,
} from './project-store.js';
import { createProjectRegistryStore } from './project-registry-state.js';

async function withProjectStore(
  rootPrefix: string,
  fn: (store: ProjectStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), rootPrefix));
  const store = createProjectStore({
    projectRegistry: createProjectRegistryStore({ root }),
  });

  try {
    await fn(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('createProjectStore isolates bootstrap roots across instances', async () => {
  await withProjectStore(
    'geulbat-project-store-a-',
    async (first, firstRoot) => {
      await withProjectStore(
        'geulbat-project-store-b-',
        async (second, secondRoot) => {
          await first.bootstrapProjectRegistry(firstRoot);
          await second.bootstrapProjectRegistry(secondRoot);

          assert.equal(
            first.getProjectRegistryFilePath(),
            join(firstRoot, '.geulbat', 'projects.json'),
          );
          assert.equal(
            second.getProjectRegistryFilePath(),
            join(secondRoot, '.geulbat', 'projects.json'),
          );
        },
      );
    },
  );
});

void test('createProjectStore mutates only its injected registry and persisted file', async () => {
  await withProjectStore(
    'geulbat-project-store-left-',
    async (leftStore, leftRoot) => {
      await withProjectStore(
        'geulbat-project-store-right-',
        async (rightStore) => {
          await leftStore.bootstrapProjectRegistry(leftRoot);
          await rightStore.bootstrapProjectRegistry();

          const snapshot = await leftStore.createProject('Alpha Route');

          assert.equal(
            snapshot.projects.some(
              (project) => project.label === 'Alpha Route',
            ),
            true,
          );
          assert.equal(
            rightStore
              .snapshotProjectRegistry()
              .projects.some((project) => project.label === 'Alpha Route'),
            false,
          );

          const persisted = JSON.parse(
            await readFile(leftStore.getProjectRegistryFilePath(), 'utf8'),
          ) as {
            version: number;
            projects: Array<{ projectId: string; label: string }>;
          };
          assert.equal(persisted.version, 1);
          assert.equal(
            persisted.projects.some(
              (project) => project.label === 'Alpha Route',
            ),
            true,
          );
        },
      );
    },
  );
});

void test('createProjectStore serializes concurrent project creation for the same registry file', async () => {
  await withProjectStore('geulbat-project-store-race-', async (store, root) => {
    await store.bootstrapProjectRegistry(root);

    await Promise.all([
      store.createProject('Alpha Route'),
      store.createProject('Beta Route'),
    ]);

    const snapshot = store.snapshotProjectRegistry();
    assert.equal(
      snapshot.projects.some((project) => project.label === 'Alpha Route'),
      true,
    );
    assert.equal(
      snapshot.projects.some((project) => project.label === 'Beta Route'),
      true,
    );

    const persisted = JSON.parse(
      await readFile(store.getProjectRegistryFilePath(), 'utf8'),
    ) as {
      version: number;
      projects: Array<{ projectId: string; label: string }>;
    };
    const labels = new Set(persisted.projects.map((project) => project.label));

    assert.equal(labels.has('Alpha Route'), true);
    assert.equal(labels.has('Beta Route'), true);
  });
});

void test('createProjectStore fails closed when persisted registry metadata is corrupted', async () => {
  await withProjectStore(
    'geulbat-project-store-corrupt-',
    async (store, root) => {
      await store.bootstrapProjectRegistry(root);
      const snapshot = await store.createProject('Alpha Route');
      const filePath = store.getProjectRegistryFilePath();
      const corruptedContents = '{"version":1,"projects":[';
      await writeFile(filePath, corruptedContents, 'utf8');

      await assert.rejects(
        () => store.reloadProjectRegistryFromDisk(),
        (error: unknown) =>
          error instanceof ProjectRegistryCorruptionError &&
          error.filePath === filePath,
      );
      assert.deepEqual(store.snapshotProjectRegistry(), snapshot);
      assert.equal(await readFile(filePath, 'utf8'), corruptedContents);

      await assert.rejects(
        () => store.createProject('Blocked Route'),
        (error: unknown) =>
          error instanceof ProjectRegistryCorruptionError &&
          error.filePath === filePath,
      );
      assert.equal(await readFile(filePath, 'utf8'), corruptedContents);
    },
  );
});

void test('createProjectStore rejects persisted registry entries with invalid projectId paths', async () => {
  await withProjectStore(
    'geulbat-project-store-invalid-id-',
    async (store, root) => {
      await store.bootstrapProjectRegistry(root);
      const filePath = store.getProjectRegistryFilePath();
      await mkdir(join(root, '.geulbat'), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify(
          {
            version: 1,
            projects: [{ projectId: '../escape', label: 'Escape' }],
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.reloadProjectRegistryFromDisk(),
        (error: unknown) =>
          error instanceof ProjectRegistryCorruptionError &&
          error.filePath === filePath,
      );
    },
  );
});

void test('createProjectStore reuses the same bootstrap promise for the same root', async () => {
  await withProjectStore(
    'geulbat-project-store-bootstrap-reuse-',
    async (store, root) => {
      const firstBoot = store.bootstrapProjectRegistry(root);
      const secondBoot = store.bootstrapProjectRegistry(root);

      assert.equal(firstBoot, secondBoot);
      await Promise.all([firstBoot, secondBoot]);
    },
  );
});

void test('createProjectStore rejects rebootstrap with a different root after boot succeeds', async () => {
  await withProjectStore(
    'geulbat-project-store-bootstrap-conflict-',
    async (store, root) => {
      const otherRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-project-store-bootstrap-other-'),
      );

      try {
        await store.bootstrapProjectRegistry(root);
        await assert.rejects(
          () => store.bootstrapProjectRegistry(otherRoot),
          /already bootstrapped/,
        );
      } finally {
        await rm(otherRoot, { recursive: true, force: true });
      }
    },
  );
});

void test('createProjectStore rolls back failed bootstrap and allows a later successful retry', async () => {
  await withProjectStore(
    'geulbat-project-store-bootstrap-rollback-',
    async (store, initialRoot) => {
      const failedRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-project-store-bootstrap-failed-'),
      );
      const failedRegistryPath = join(failedRoot, '.geulbat', 'projects.json');

      try {
        await mkdir(join(failedRoot, '.geulbat'), { recursive: true });
        await writeFile(
          failedRegistryPath,
          '{"version":1,"projects":[',
          'utf8',
        );

        await assert.rejects(
          () => store.bootstrapProjectRegistry(failedRoot),
          (error: unknown) =>
            error instanceof ProjectRegistryCorruptionError &&
            error.filePath === failedRegistryPath,
        );

        assert.equal(
          store.getProjectRegistryFilePath(),
          join(initialRoot, '.geulbat', 'projects.json'),
        );

        await writeFile(
          failedRegistryPath,
          JSON.stringify(
            {
              version: 1,
              projects: [{ projectId: 'workspace', label: 'Workspace' }],
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );

        await store.bootstrapProjectRegistry(failedRoot);
        assert.equal(store.getProjectRegistryFilePath(), failedRegistryPath);
      } finally {
        await rm(failedRoot, { recursive: true, force: true });
      }
    },
  );
});
