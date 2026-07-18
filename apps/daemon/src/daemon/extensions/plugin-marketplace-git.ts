// Plugin marketplace git 서브프로세스 레인 — 격리된 설정 루트(전역/시스템
// git 설정·훅 차단, allowlist 환경변수)에서 얕은 clone과 rev-parse만
// 수행한다. store는 이 레인의 두 진입점만 부른다.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildAllowlistedProcessEnv,
  runBoundedProcessCommand,
} from '../utils/process-command.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';

const GIT_REVISION_PATTERN = /^git:[a-f0-9]{40,64}$/u;
const NETWORK_ENV_KEYS = [
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
] as const;

export async function acquirePluginMarketplaceGitRepository(args: {
  repositoryRoot: string;
  url: string;
  requestedRef: string | null;
  isolatedConfigRoot: string;
}): Promise<void> {
  await mkdir(args.isolatedConfigRoot, { recursive: true, mode: 0o700 });
  const hooksRoot = join(args.isolatedConfigRoot, 'hooks');
  await mkdir(hooksRoot, { recursive: true, mode: 0o700 });
  const env = {
    ...buildAllowlistedProcessEnv(NETWORK_ENV_KEYS),
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_GLOBAL: join(args.isolatedConfigRoot, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: args.isolatedConfigRoot,
    XDG_CONFIG_HOME: args.isolatedConfigRoot,
  } satisfies NodeJS.ProcessEnv;
  await runGit(
    ['init', '--quiet', args.repositoryRoot],
    env,
    'Git marketplace repository initialization failed',
  );
  await runGit(
    ['-C', args.repositoryRoot, 'config', 'core.hooksPath', hooksRoot],
    env,
    'Git marketplace hook isolation failed',
  );
  await runGit(
    ['-C', args.repositoryRoot, 'remote', 'add', 'origin', args.url],
    env,
    'Git marketplace source registration failed',
  );
  await runGit(
    [
      '-C',
      args.repositoryRoot,
      'fetch',
      '--depth=1',
      '--no-tags',
      'origin',
      args.requestedRef ?? 'HEAD',
    ],
    env,
    'Git marketplace fetch failed',
  );
  await runGit(
    [
      '-C',
      args.repositoryRoot,
      'checkout',
      '--detach',
      '--force',
      'FETCH_HEAD',
    ],
    env,
    'Git marketplace checkout failed',
  );
}

export async function readGitRevision(
  repositoryRoot: string,
  marketplaceId: string,
): Promise<string> {
  const env = {
    ...buildAllowlistedProcessEnv([]),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  } satisfies NodeJS.ProcessEnv;
  const result = await runBoundedProcessCommand({
    executable: 'git',
    args: ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
    env,
  });
  if (result.kind !== 'exit' || result.exitCode !== 0) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      `managed marketplace revision is unreadable: ${marketplaceId}`,
    );
  }
  const revision = `git:${result.stdout.trim()}`;
  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'managed marketplace revision is invalid',
    );
  }
  return revision;
}

async function runGit(
  gitArgs: string[],
  env: NodeJS.ProcessEnv,
  failureMessage: string,
): Promise<void> {
  const result = await runBoundedProcessCommand({
    executable: 'git',
    args: gitArgs,
    env,
  });
  if (result.kind !== 'exit' || result.exitCode !== 0) {
    throw new PluginMarketplaceStoreError('invalid_request', failureMessage);
  }
}
