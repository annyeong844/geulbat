#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const eslintBin = fileURLToPath(
  new URL('../node_modules/eslint/bin/eslint.js', import.meta.url),
);
const oxlintBin = fileURLToPath(
  new URL('../node_modules/oxlint/bin/oxlint', import.meta.url),
);
const tsgolintPackageBin = fileURLToPath(
  new URL('../node_modules/oxlint-tsgolint/bin/tsgolint.js', import.meta.url),
);

export const FULL_LINT_PATTERNS = [
  'packages/*/src/**/*.ts',
  'apps/*/src/**/*.{ts,tsx}',
  'apps/*/scripts/**/*.mjs',
  'scripts/*.mjs',
  '.rustlike/*.mjs',
];

const FULL_LINT_SEED_CACHE = '.eslintcache.full.seed';
const TSGOLINT_ADAPTER = 'tsgolint';

export const TSGOLINT_EXPECTED_RULE_IDS = [
  'await-thenable',
  'no-array-delete',
  'no-base-to-string',
  'no-duplicate-type-constituents',
  'no-floating-promises',
  'no-for-in-array',
  'no-implied-eval',
  'no-misused-promises',
  'no-misused-spread',
  'no-mixed-enums',
  'no-redundant-type-constituents',
  'no-unsafe-argument',
  'no-unsafe-assignment',
  'no-unsafe-call',
  'no-unsafe-enum-comparison',
  'no-unsafe-member-access',
  'no-unsafe-return',
  'no-unsafe-unary-minus',
  'only-throw-error',
  'prefer-promise-reject-errors',
  'related-getter-setter-pairs',
  'require-array-sort-compare',
  'restrict-plus-operands',
  'restrict-template-expressions',
  'unbound-method',
  'use-unknown-in-catch-callback-variable',
];

export const OXLINT_PRODUCTION_RULE_IDS = [
  'unicorn/prefer-node-protocol',
  'unicorn/throw-new-error',
  'unicorn/prefer-string-slice',
];

export const OXLINT_WEB_SHELL_RULE_IDS = [
  'react/jsx-key',
  'jsx-a11y/aria-role',
  'jsx-a11y/click-events-have-key-events',
  'jsx-a11y/interactive-supports-focus',
  'jsx-a11y/media-has-caption',
  'jsx-a11y/no-noninteractive-element-interactions',
  'jsx-a11y/no-static-element-interactions',
];

export const TSGOLINT_PROJECTS = [
  {
    targetPath: 'apps/daemon/src',
  },
  {
    targetPath: 'apps/web-shell/src',
  },
  {
    targetPath: 'packages/agent-loop/src',
  },
  {
    targetPath: 'packages/protocol/src',
  },
  {
    targetPath: 'packages/shared-utils/src',
  },
  {
    targetPath: 'packages/tool-sdk/src',
  },
  {
    targetPath: 'packages/tool-library/src',
  },
];

export const LINT_SHARDS = [
  {
    name: 'daemon-source',
    cacheLocation: '.eslintcache.full.daemon-source',
    patterns: ['apps/daemon/src/**/*.ts'],
    ignorePatterns: [
      'apps/daemon/src/**/*.test.ts',
      'apps/daemon/src/test-support/**/*.ts',
    ],
  },
  {
    name: 'daemon-tests',
    cacheLocation: '.eslintcache.full.daemon-tests',
    patterns: [
      'apps/daemon/src/**/*.test.ts',
      'apps/daemon/src/test-support/**/*.ts',
    ],
  },
  {
    name: 'web-shell',
    cacheLocation: '.eslintcache.full.web-shell',
    patterns: ['apps/web-shell/src/**/*.{ts,tsx}'],
  },
  {
    name: 'support',
    cacheLocation: '.eslintcache.full.support',
    patterns: [
      'packages/*/src/**/*.ts',
      'apps/*/scripts/**/*.mjs',
      'scripts/*.mjs',
      '.rustlike/*.mjs',
    ],
  },
];

export function requiresLintSeed(
  shards = LINT_SHARDS,
  { cwd = process.cwd() } = {},
) {
  return shards.some((shard) => !existsSync(resolve(cwd, shard.cacheLocation)));
}

export function parseTypedLintAdapter(args = []) {
  if (args.length === 0) {
    return null;
  }
  if (args.length !== 1 || args[0] !== `--typed-adapter=${TSGOLINT_ADAPTER}`) {
    throw new Error(
      `unsupported lint arguments: ${args.join(' ') || '(none)'}`,
    );
  }
  return TSGOLINT_ADAPTER;
}

export function buildOxlintTypedArgs({
  ruleIds = TSGOLINT_EXPECTED_RULE_IDS,
  targetPath,
}) {
  const webShellRuleIds =
    targetPath === 'apps/web-shell/src' ? OXLINT_WEB_SHELL_RULE_IDS : [];

  return [
    '--type-aware',
    '--allow=all',
    ...(webShellRuleIds.length > 0
      ? ['--react-plugin', '--jsx-a11y-plugin']
      : []),
    ...ruleIds.map((ruleId) => `--deny=typescript/${ruleId}`),
    ...OXLINT_PRODUCTION_RULE_IDS.map((ruleId) => `--deny=${ruleId}`),
    ...webShellRuleIds.map((ruleId) => `--deny=${ruleId}`),
    '--ignore-pattern=**/*.test.ts',
    '--ignore-pattern=**/*.test.tsx',
    '--ignore-pattern=**/src/test-support/**',
    targetPath,
  ];
}

export async function runOxlintTypedAdapter({
  cwd = process.cwd(),
  env = process.env,
  cliPath = oxlintBin,
  backendPackagePath = tsgolintPackageBin,
  projects = TSGOLINT_PROJECTS,
  ruleIds = TSGOLINT_EXPECTED_RULE_IDS,
} = {}) {
  if (!existsSync(cliPath) || !existsSync(backendPackagePath)) {
    throw new Error(
      'official Oxlint type-aware packages are missing; run npm ci with optional dependencies enabled',
    );
  }

  const results = [];
  for (const project of projects) {
    const startedAt = Date.now();
    console.log(`typed lint -> ${project.targetPath} started`);
    const result = await new Promise((resolveResult) => {
      const child = spawn(
        process.execPath,
        [
          cliPath,
          ...buildOxlintTypedArgs({
            ruleIds,
            targetPath: project.targetPath,
          }),
        ],
        {
          cwd,
          env: env.GEULBAT_TSGOLINT_BIN
            ? {
                ...env,
                OXLINT_TSGOLINT_PATH: env.GEULBAT_TSGOLINT_BIN,
              }
            : env,
          stdio: 'inherit',
        },
      );
      let spawnError;
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code, signal) => {
        resolveResult({
          name: `typed:${project.targetPath}`,
          code: spawnError ? 1 : (code ?? 1),
          error: spawnError,
          signal,
        });
      });
    });
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      `typed lint -> ${project.targetPath} ${
        result.code === 0 ? 'passed' : 'failed'
      } (${elapsedSeconds}s)`,
    );
    results.push(result);
  }
  return results;
}

async function runEslintProcesses(processes, { cwd, env }) {
  const activeChildren = new Set();
  const stopChildren = (signal) => {
    for (const child of activeChildren) {
      child.kill(signal);
    }
  };
  const signalHandlers = [
    ['SIGINT', stopChildren],
    ['SIGTERM', stopChildren],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  try {
    return await Promise.all(
      processes.map(
        (lintProcess) =>
          new Promise((resolveResult) => {
            const startedAt = Date.now();
            console.log(`lint -> ${lintProcess.name} started`);
            const child = spawn(
              process.execPath,
              [
                eslintBin,
                '--cache',
                '--cache-location',
                lintProcess.cacheLocation,
                ...(lintProcess.ignorePatterns ?? []).flatMap((pattern) => [
                  '--ignore-pattern',
                  pattern,
                ]),
                ...lintProcess.patterns,
              ],
              { cwd, env, stdio: 'inherit' },
            );
            activeChildren.add(child);
            let spawnError;
            child.once('error', (error) => {
              spawnError = error;
            });
            child.once('close', (code, signal) => {
              activeChildren.delete(child);
              const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(
                2,
              );
              const exitCode = spawnError ? 1 : (code ?? 1);
              console.log(
                `lint -> ${lintProcess.name} ${
                  exitCode === 0 ? 'passed' : 'failed'
                } (${elapsedSeconds}s)`,
              );
              resolveResult({
                name: lintProcess.name,
                code: exitCode,
                error: spawnError,
                signal,
              });
            });
          }),
      ),
    );
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

async function runEslintShards(
  shards = LINT_SHARDS,
  {
    cwd = process.cwd(),
    env = process.env,
    seedCacheLocation = FULL_LINT_SEED_CACHE,
  } = {},
) {
  if (!requiresLintSeed(shards, { cwd })) {
    return runEslintProcesses(shards, { cwd, env });
  }

  console.log(
    'lint -> building cold cache without mounted-filesystem contention',
  );
  const results = await runEslintProcesses(
    [
      {
        name: 'cold-seed',
        cacheLocation: seedCacheLocation,
        patterns: FULL_LINT_PATTERNS,
      },
    ],
    { cwd, env },
  );
  const seedCache = resolve(cwd, seedCacheLocation);
  if (
    existsSync(seedCache) &&
    results.every((result) => result.error === undefined)
  ) {
    await Promise.all(
      shards.map((shard) =>
        copyFile(seedCache, resolve(cwd, shard.cacheLocation)),
      ),
    );
  }
  return results;
}

async function main(
  args = process.argv.slice(2),
  { cwd = process.cwd(), env = process.env } = {},
) {
  let typedAdapter;
  try {
    typedAdapter = parseTypedLintAdapter(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const eslintEnv = typedAdapter
    ? { ...env, GEULBAT_TYPED_LINT_ADAPTER: typedAdapter }
    : env;
  const eslintShards = typedAdapter
    ? LINT_SHARDS.map((shard) => ({
        ...shard,
        cacheLocation: `${shard.cacheLocation}.${typedAdapter}`,
      }))
    : LINT_SHARDS;

  let resultGroups;
  try {
    resultGroups = await Promise.all([
      ...(typedAdapter ? [runOxlintTypedAdapter({ cwd, env })] : []),
      runEslintShards(eslintShards, {
        cwd,
        env: eslintEnv,
        seedCacheLocation: typedAdapter
          ? `${FULL_LINT_SEED_CACHE}.${typedAdapter}`
          : FULL_LINT_SEED_CACHE,
      }),
    ]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const results = resultGroups.flat();
  const failures = results.filter((result) => result.code !== 0);
  if (failures.length > 0) {
    console.error(
      `lint failed in ${failures.map((failure) => failure.name).join(', ')}`,
    );
    return failures[0].code || 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
