import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  isPluginDeleteResponse,
  isPluginListResponse,
  isPluginMarketplaceDeleteResponse,
  isPluginMarketplaceListResponse,
  isPluginMarketplaceMutationResponse,
  isPluginMutationResponse,
  isPluginSkillListResponse,
} from '@geulbat/protocol/plugins';

import { createPluginMarketplaceStore } from './daemon/extensions/plugin-marketplace-store.js';

import {
  authHeaders,
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  getHomeStateRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('authenticated plugin routes install, list, toggle, and remove a managed local package', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const computerRoot = getComputerFileRootFromContext(daemonContext);
  const sourceRoot = join(computerRoot, 'plugins', 'route-example');
  await writePluginFixture(sourceRoot);

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const installResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins`,
        {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            root: 'computer',
            path: 'plugins/route-example',
          }),
        },
      );
      assert.equal(installResponse.status, 201);
      const installed: unknown = await installResponse.json();
      assert.equal(isPluginMutationResponse(installed), true);
      if (!isPluginMutationResponse(installed)) {
        return;
      }
      assert.equal(installed.plugin.name, 'route-example');
      assert.equal(installed.plugin.enabled, false);
      assert.deepEqual(installed.plugin.capabilities, [
        {
          kind: 'skills',
          supportStatus: 'supported',
          itemCount: 1,
        },
      ]);
      const publicPayload = JSON.stringify(installed);
      assert.doesNotMatch(
        publicPayload,
        new RegExp(escapeRegExp(computerRoot), 'u'),
      );
      assert.doesNotMatch(
        publicPayload,
        new RegExp(
          escapeRegExp(getHomeStateRootFromContext(daemonContext)),
          'u',
        ),
      );
      await access(
        join(
          await getManagedPluginPackageRoot(
            getHomeStateRootFromContext(daemonContext),
            installed.plugin.installationId,
          ),
          'skills',
          'route-example',
          'SKILL.md',
        ),
      );

      const listResponse = await fetch(`http://127.0.0.1:${port}/api/plugins`, {
        headers: authHeaders(),
      });
      assert.equal(listResponse.status, 200);
      const listed: unknown = await listResponse.json();
      assert.equal(isPluginListResponse(listed), true);
      if (isPluginListResponse(listed)) {
        assert.deepEqual(listed.plugins, [installed.plugin]);
      }

      const skillListResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/skills`,
        { headers: authHeaders() },
      );
      assert.equal(skillListResponse.status, 200);
      const skillList: unknown = await skillListResponse.json();
      assert.equal(isPluginSkillListResponse(skillList), true);
      if (isPluginSkillListResponse(skillList)) {
        assert.equal(skillList.diagnostics.length, 0);
        assert.deepEqual(
          skillList.skills
            .filter((skill) => skill.pluginName === 'geulbat-creators')
            .map((skill) => skill.name),
          ['plugin-creator', 'skill-creator'],
        );
        const routeSkill = skillList.skills.find(
          (skill) => skill.name === 'route-example',
        );
        assert.deepEqual(routeSkill, {
          skillRef: routeSkill?.skillRef,
          name: 'route-example',
          description: 'Route fixture skill',
          enabled: false,
          allowImplicitInvocation: true,
          runtimeStatus: 'available',
          pluginInstallationId: installed.plugin.installationId,
          pluginName: 'route-example',
          pluginDisplayName: 'route-example',
          pluginVersion: '1.0.0',
        });
        assert.match(
          routeSkill?.skillRef ?? '',
          new RegExp(
            `^geulbat-skill/${installed.plugin.installationId}/[a-f0-9]{64}$`,
            'u',
          ),
        );
        const skillPayload = JSON.stringify(skillList);
        assert.doesNotMatch(
          skillPayload,
          new RegExp(escapeRegExp(computerRoot), 'u'),
        );
        assert.doesNotMatch(
          skillPayload,
          new RegExp(
            escapeRegExp(getHomeStateRootFromContext(daemonContext)),
            'u',
          ),
        );
      }

      const enableResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/${installed.plugin.installationId}/enabled`,
        {
          method: 'PATCH',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ enabled: true }),
        },
      );
      assert.equal(enableResponse.status, 200);
      const enabled: unknown = await enableResponse.json();
      assert.equal(isPluginMutationResponse(enabled), true);
      if (isPluginMutationResponse(enabled)) {
        assert.equal(enabled.plugin.enabled, true);
      }

      const deleteResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/${installed.plugin.installationId}`,
        { method: 'DELETE', headers: authHeaders() },
      );
      assert.equal(deleteResponse.status, 200);
      const deleted: unknown = await deleteResponse.json();
      assert.equal(isPluginDeleteResponse(deleted), true);
      if (isPluginDeleteResponse(deleted)) {
        assert.equal(
          deleted.removedInstallationId,
          installed.plugin.installationId,
        );
      }
    },
    { daemonContext },
  );
});

void test('marketplace routes add a Git catalog, install exact listed bytes, and preserve the installed copy after source removal', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const homeStateRoot = getHomeStateRootFromContext(daemonContext);
  daemonContext.pluginMarketplaces = createPluginMarketplaceStore({
    homeStateRoot,
    acquireGitRepository: async ({ repositoryRoot }) => {
      await writeMarketplaceFixture(repositoryRoot);
    },
  });

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const addResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces`,
        {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            sourceKind: 'git',
            url: 'https://github.com/example/route-marketplace.git',
            ref: 'main',
          }),
        },
      );
      assert.equal(addResponse.status, 201);
      const added: unknown = await addResponse.json();
      assert.equal(isPluginMarketplaceMutationResponse(added), true);
      if (!isPluginMarketplaceMutationResponse(added)) {
        return;
      }
      assert.equal(added.marketplace.sourceRole, 'custom');

      const catalogResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces`,
        { headers: authHeaders() },
      );
      assert.equal(catalogResponse.status, 200);
      const catalog: unknown = await catalogResponse.json();
      assert.equal(isPluginMarketplaceListResponse(catalog), true);
      if (!isPluginMarketplaceListResponse(catalog)) {
        return;
      }
      const entry = catalog.entries[0];
      assert.equal(entry?.status, 'installable');
      assert.equal(entry?.iconAvailable, true);
      assert.ok(entry?.contentDigest);

      const iconResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces/${encodeURIComponent(added.marketplace.marketplaceId)}/entries/${encodeURIComponent(entry.entryId)}/icon`,
        { headers: authHeaders() },
      );
      assert.equal(iconResponse.status, 200);
      assert.equal(iconResponse.headers.get('content-type'), 'image/png');
      assert.equal(
        iconResponse.headers.get('x-content-type-options'),
        'nosniff',
      );
      assert.equal(await iconResponse.text(), 'route-icon');

      const installResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces/install`,
        {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            marketplaceId: added.marketplace.marketplaceId,
            entryId: entry.entryId,
            expectedContentDigest: entry.contentDigest,
          }),
        },
      );
      assert.equal(installResponse.status, 201);
      const installed: unknown = await installResponse.json();
      assert.equal(isPluginMutationResponse(installed), true);
      if (!isPluginMutationResponse(installed)) {
        return;
      }
      assert.equal(installed.plugin.sourceKind, 'marketplace');
      assert.equal(
        installed.plugin.marketplaceSource?.marketplaceId,
        added.marketplace.marketplaceId,
      );
      const publicPayload = JSON.stringify(installed);
      assert.doesNotMatch(
        publicPayload,
        new RegExp(escapeRegExp(homeStateRoot), 'u'),
      );
      assert.doesNotMatch(
        publicPayload,
        /packageObjectId|sourceRoot|managedPath/u,
      );

      const removeResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces/${encodeURIComponent(added.marketplace.marketplaceId)}`,
        { method: 'DELETE', headers: authHeaders() },
      );
      assert.equal(removeResponse.status, 200);
      const removed: unknown = await removeResponse.json();
      assert.equal(isPluginMarketplaceDeleteResponse(removed), true);

      const pluginsResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins`,
        { headers: authHeaders() },
      );
      const plugins: unknown = await pluginsResponse.json();
      assert.equal(isPluginListResponse(plugins), true);
      if (isPluginListResponse(plugins)) {
        assert.deepEqual(plugins.plugins, [installed.plugin]);
      }
    },
    { daemonContext },
  );
});

void test('official marketplace route connects the Codex catalog without caller source policy', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const homeStateRoot = getHomeStateRootFromContext(daemonContext);
  let acquisitionCount = 0;
  daemonContext.pluginMarketplaces = createPluginMarketplaceStore({
    homeStateRoot,
    acquireGitRepository: async ({ repositoryRoot, url, requestedRef }) => {
      acquisitionCount += 1;
      assert.equal(url, 'https://github.com/openai/plugins.git');
      assert.equal(requestedRef, 'main');
      await writeMarketplaceFixture(repositoryRoot, { official: true });
    },
  });

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const endpoint = `http://127.0.0.1:${port}/api/plugins/marketplaces/official`;
      const firstResponse = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(),
      });
      assert.equal(firstResponse.status, 200);
      const first: unknown = await firstResponse.json();
      assert.equal(isPluginMarketplaceMutationResponse(first), true);
      if (!isPluginMarketplaceMutationResponse(first)) {
        return;
      }
      assert.equal(first.marketplace.name, 'openai-curated');
      assert.equal(first.marketplace.sourceRole, 'official');

      const secondResponse = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(),
      });
      assert.equal(secondResponse.status, 200);
      assert.equal(acquisitionCount, 1);

      const rejectedPolicy = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          url: 'https://example.invalid/not-the-official-source.git',
        }),
      });
      assert.equal(rejectedPolicy.status, 400);

      const catalogResponse = await fetch(
        `http://127.0.0.1:${port}/api/plugins/marketplaces`,
        { headers: authHeaders() },
      );
      const catalog: unknown = await catalogResponse.json();
      assert.equal(isPluginMarketplaceListResponse(catalog), true);
      if (isPluginMarketplaceListResponse(catalog)) {
        assert.equal(catalog.sources[0]?.sourceRole, 'official');
        assert.equal(catalog.entries[0]?.status, 'installable');
      }
    },
    { daemonContext },
  );
});

void test('plugin routes reject path escape and secret-bearing request fields without echoing them', async () => {
  const secretSentinel = 'plugin-route-secret-sentinel';
  await withAuthenticatedDaemonServer(async ({ port }) => {
    for (const requestBody of [
      { root: 'computer', path: '../outside' },
      {
        root: 'computer',
        path: 'plugins/example',
        secretValue: secretSentinel,
      },
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/plugins`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(requestBody),
      });
      assert.equal(response.status, 400);
      assert.doesNotMatch(
        await response.text(),
        new RegExp(secretSentinel, 'u'),
      );
    }
  });
});

void test('plugin routes report an unknown installation without exposing storage details', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/plugins/00000000-0000-4000-8000-000000000000/enabled`,
      {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ enabled: true }),
      },
    );
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.doesNotMatch(body, /extensions|registry\.json|managed package/iu);
  });
});

async function writePluginFixture(packageRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(packageRoot, '.codex-plugin'), { recursive: true }),
    mkdir(join(packageRoot, 'skills', 'route-example'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'route-example',
        version: '1.0.0',
        description: 'Route boundary fixture.',
        skills: './skills',
      }),
      'utf8',
    ),
    writeFile(
      join(packageRoot, 'skills', 'route-example', 'SKILL.md'),
      '---\nname: route-example\ndescription: Route fixture skill\n---\n',
      'utf8',
    ),
  ]);
}

async function writeMarketplaceFixture(
  repositoryRoot: string,
  options?: { official?: boolean },
): Promise<void> {
  const packageRoot = join(repositoryRoot, 'plugins', 'route-marketplace');
  await Promise.all([
    mkdir(join(repositoryRoot, '.agents', 'plugins'), { recursive: true }),
    mkdir(join(packageRoot, '.codex-plugin'), { recursive: true }),
    mkdir(join(packageRoot, 'assets'), { recursive: true }),
    mkdir(join(packageRoot, 'skills', 'route-marketplace'), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      join(repositoryRoot, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: options?.official ? 'openai-curated' : 'route-marketplace',
        interface: {
          displayName: options?.official
            ? 'Codex official'
            : 'Route marketplace',
        },
        plugins: [
          {
            name: 'route-marketplace',
            source: { source: 'local', path: './plugins/route-marketplace' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Productivity',
          },
        ],
      }),
      'utf8',
    ),
    writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'route-marketplace',
        version: '1.0.0',
        description: 'Marketplace route fixture.',
        interface: {
          displayName: 'Route marketplace',
          logo: './assets/logo.png',
        },
        skills: './skills',
      }),
      'utf8',
    ),
    writeFile(join(packageRoot, 'assets', 'logo.png'), 'route-icon', 'utf8'),
    writeFile(
      join(packageRoot, 'skills', 'route-marketplace', 'SKILL.md'),
      '---\nname: route-marketplace\ndescription: Route marketplace skill\n---\n',
      'utf8',
    ),
  ]);
  runGit(repositoryRoot, ['init', '--quiet']);
  runGit(repositoryRoot, ['config', 'user.email', 'fixture@example.com']);
  runGit(repositoryRoot, ['config', 'user.name', 'Fixture']);
  runGit(repositoryRoot, ['add', '.']);
  runGit(repositoryRoot, ['commit', '--quiet', '-m', 'route marketplace']);
}

async function getManagedPluginPackageRoot(
  homeStateRoot: string,
  installationId: string,
): Promise<string> {
  const registry = JSON.parse(
    await readFile(join(homeStateRoot, 'extensions', 'registry.json'), 'utf8'),
  ) as {
    plugins: Array<{
      packageObjectId: string;
      view: { installationId: string };
    }>;
  };
  const record = registry.plugins.find(
    (candidate) => candidate.view.installationId === installationId,
  );
  assert.ok(record, `missing registry record for ${installationId}`);
  return join(
    homeStateRoot,
    'extensions',
    'plugins',
    record.packageObjectId,
    'package',
  );
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
