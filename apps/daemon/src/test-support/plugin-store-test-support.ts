import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InstalledPluginView } from '@geulbat/protocol/plugins';

import type { ComputerFileScope } from '../daemon/files/computer-file-scope.js';
import { createPluginStore } from '../daemon/extensions/plugin-store.js';
import { PluginStoreError } from '../daemon/extensions/plugin-store-contract.js';

export async function createFixture(label: string): Promise<{
  root: string;
  computerRoot: string;
  homeRoot: string;
  computerFileScope: ComputerFileScope;
}> {
  const root = await mkdtemp(join(tmpdir(), `geulbat-plugin-${label}-`));
  const computerRoot = join(root, 'computer');
  const homeRoot = join(root, 'home');
  await mkdir(computerRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  return {
    root,
    computerRoot,
    homeRoot,
    computerFileScope: {
      root: computerRoot,
      browseShortcuts: [],
    },
  };
}

export async function writePluginPackage(
  packageRoot: string,
  args: {
    manifest: Record<string, unknown>;
    files?: Record<string, string>;
  },
): Promise<void> {
  const files = {
    '.codex-plugin/plugin.json': JSON.stringify(args.manifest, null, 2),
    ...args.files,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(packageRoot, ...relativePath.split('/'));
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

export async function assertRejectedWithoutPublication(
  store: ReturnType<typeof createPluginStore>,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourcePath: string,
): Promise<void> {
  await assert.rejects(
    store.installPlugin(
      { root: 'computer', path: sourcePath },
      fixture.computerFileScope,
    ),
    (error: unknown) =>
      error instanceof PluginStoreError && error.code === 'invalid_request',
  );
  await assertNoPublication(fixture, store);
}

export async function assertNoPublication(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  store: ReturnType<typeof createPluginStore>,
): Promise<void> {
  assert.deepEqual(store.listPlugins(), []);
  assert.equal(
    await exists(join(fixture.homeRoot, 'extensions', 'registry.json')),
    false,
  );
  assert.deepEqual(
    await readdir(join(fixture.homeRoot, 'extensions', '.staging')),
    [],
  );
  assert.deepEqual(
    await readdir(join(fixture.homeRoot, 'extensions', 'plugins')),
    [],
  );
}

interface PersistedPluginRecordFixture {
  view: InstalledPluginView;
  packageObjectId: string;
}

export async function getManagedPluginPackageRoot(
  homeRoot: string,
  installationId: string,
): Promise<string> {
  const registry = await readCurrentRegistryFixture(homeRoot);
  const record = registry.plugins.find(
    (candidate) => candidate.view.installationId === installationId,
  );
  assert.ok(record, `missing registry record for ${installationId}`);
  return join(
    homeRoot,
    'extensions',
    'plugins',
    record.packageObjectId,
    'package',
  );
}

export async function downgradeRegistryFixture(args: {
  homeRoot: string;
  installed: InstalledPluginView;
  schemaVersion: 1 | 2 | 3;
  mutateView: (view: InstalledPluginView) => unknown;
}): Promise<void> {
  const registry = await readCurrentRegistryFixture(args.homeRoot);
  const record = registry.plugins.find(
    (candidate) =>
      candidate.view.installationId === args.installed.installationId,
  );
  assert.ok(
    record,
    `missing registry record for ${args.installed.installationId}`,
  );
  const pluginsRoot = join(args.homeRoot, 'extensions', 'plugins');
  await rename(
    join(pluginsRoot, record.packageObjectId),
    join(pluginsRoot, args.installed.installationId),
  );
  await writeFile(
    join(args.homeRoot, 'extensions', 'registry.json'),
    `${JSON.stringify(
      {
        schemaVersion: args.schemaVersion,
        plugins: [args.mutateView(record.view)],
      },
      null,
      2,
    )}\n`,
  );
}

export async function readCurrentRegistryFixture(homeRoot: string): Promise<{
  schemaVersion: number;
  plugins: PersistedPluginRecordFixture[];
}> {
  return JSON.parse(
    await readFile(join(homeRoot, 'extensions', 'registry.json'), 'utf8'),
  ) as {
    schemaVersion: number;
    plugins: PersistedPluginRecordFixture[];
  };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
