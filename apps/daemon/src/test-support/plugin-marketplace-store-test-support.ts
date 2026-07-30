import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginMarketplaceStore as createProductPluginMarketplaceStore } from '../daemon/extensions/plugin-marketplace-store.js';
import type { PluginMarketplaceCommandRunner } from '../daemon/extensions/plugin-marketplace-git.js';

export const runMarketplaceTestCommand: PluginMarketplaceCommandRunner = async (
  args,
) => {
  const result = spawnSync(args.executable, [...args.args], {
    encoding: 'utf8',
    env: args.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  return {
    exitCode: result.status,
    stdout: result.stdout,
  };
};

export function createPluginMarketplaceStore(
  args: Parameters<typeof createProductPluginMarketplaceStore>[0],
) {
  return createProductPluginMarketplaceStore({
    ...args,
    runCommand: args.runCommand ?? runMarketplaceTestCommand,
  });
}

export async function createMarketplaceFixture(options?: {
  includeUnsupportedNpm?: boolean;
  invalidManifest?: boolean;
  omitIcon?: boolean;
  marketplaceName?: string;
  marketplaceDisplayName?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-marketplace-'));
  const repositoryRoot = join(root, 'source');
  const pluginRoot = join(repositoryRoot, 'plugins', 'workflow-helper');
  await mkdir(join(repositoryRoot, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, 'assets'), { recursive: true });
  await mkdir(join(pluginRoot, 'skills', 'workflow'), { recursive: true });
  const entries: unknown[] = [
    {
      name: 'workflow-helper',
      source: { source: 'local', path: './plugins/workflow-helper' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ];
  if (options?.includeUnsupportedNpm) {
    entries.push({
      name: 'npm-helper',
      source: {
        source: 'npm',
        package: '@example/npm-helper',
        version: '^1.0.0',
      },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    });
  }
  await writeFile(
    join(repositoryRoot, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify(
      {
        name: options?.marketplaceName ?? 'fixture-marketplace',
        interface: {
          displayName: options?.marketplaceDisplayName ?? 'Fixture marketplace',
        },
        plugins: entries,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify(
      options?.invalidManifest
        ? { name: 'different-name', version: '1.0.0', description: 'Invalid.' }
        : {
            name: 'workflow-helper',
            version: '1.0.0',
            description: 'A fixture workflow.',
            interface: {
              displayName: 'Workflow helper',
              ...(options?.omitIcon ? {} : { logo: './assets/logo.png' }),
            },
            skills: './skills',
          },
      null,
      2,
    )}\n`,
  );
  if (!options?.omitIcon) {
    await writeFile(join(pluginRoot, 'assets', 'logo.png'), 'fixture-icon');
  }
  await writeFile(
    join(pluginRoot, 'skills', 'workflow', 'SKILL.md'),
    '---\nname: authored-workflow\ndescription: Use the fixture workflow.\nmetadata:\n  priority: 2\n  tags: [fixture, workflow]\nallowed-tools:\n  - Read\n---\n\n# Workflow\n',
  );
  runGit(repositoryRoot, ['init', '--quiet']);
  runGit(repositoryRoot, ['config', 'user.email', 'fixture@example.com']);
  runGit(repositoryRoot, ['config', 'user.name', 'Fixture']);
  runGit(repositoryRoot, ['add', '.']);
  runGit(repositoryRoot, ['commit', '--quiet', '-m', 'fixture marketplace']);
  return {
    root,
    repositoryRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
