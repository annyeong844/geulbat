#!/usr/bin/env node
/**
 * Compile and run one workspace's node:test suite as a single owned lifecycle.
 *
 * Each invocation runs from a private output beside the workspace's legacy
 * dist-test directory so compiled tests keep the same relative depth. A
 * persistent compilation cache can seed that private output, but tests never
 * execute inside or mutate the shared cache.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnOwnedChildProcess } from './owned-child-process.mjs';
import { main as runNodeTests } from './run-node-tests-fail-fast.mjs';

const typescriptCli = resolve(
  dirname(
    createRequire(import.meta.url).resolve('@typescript/native/package.json'),
  ),
  'bin/tsc',
);
const c8Cli = createRequire(import.meta.url).resolve('c8/bin/c8.js');
const nodeTestRunnerCli = fileURLToPath(
  new URL('./run-node-tests-fail-fast.mjs', import.meta.url),
);
const workspaceTestBuildCacheDirectory = 'dist-test-cache';
const workspaceTestBuildCacheLock = 'dist-test-cache.lock';
const workspaceTestBuildInfoFile = 'tsconfig.test.tsbuildinfo';

function parseWorkspaceTestArgs(args) {
  const patterns = [];
  let coverageOutput;
  let jobs;
  let postBuildScript;
  let tsconfig = './tsconfig.test.json';
  let workspace;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      patterns.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--coverage-output') {
      coverageOutput = args[index + 1];
      if (coverageOutput === undefined) {
        throw new Error('--coverage-output requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--coverage-output=')) {
      coverageOutput = argument.slice('--coverage-output='.length);
      continue;
    }
    if (argument === '--jobs') {
      jobs = args[index + 1];
      if (jobs === undefined) {
        throw new Error('--jobs requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--jobs=')) {
      jobs = argument.slice('--jobs='.length);
      continue;
    }
    if (argument === '--post-build-script') {
      postBuildScript = args[index + 1];
      if (postBuildScript === undefined) {
        throw new Error('--post-build-script requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--post-build-script=')) {
      postBuildScript = argument.slice('--post-build-script='.length);
      continue;
    }
    if (argument === '--tsconfig') {
      tsconfig = args[index + 1];
      if (tsconfig === undefined) {
        throw new Error('--tsconfig requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--tsconfig=')) {
      tsconfig = argument.slice('--tsconfig='.length);
      continue;
    }
    if (argument === '--workspace') {
      workspace = args[index + 1];
      if (workspace === undefined) {
        throw new Error('--workspace requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--workspace=')) {
      workspace = argument.slice('--workspace='.length);
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`unknown workspace test option: ${argument}`);
    }
    patterns.push(argument);
  }

  const parsedJobs = jobs === undefined ? undefined : Number(jobs);
  if (
    parsedJobs !== undefined &&
    (!Number.isInteger(parsedJobs) || parsedJobs < 1)
  ) {
    throw new Error(`--jobs must be a positive integer, received: ${jobs}`);
  }
  for (const [name, value] of [
    ['--coverage-output', coverageOutput],
    ['--post-build-script', postBuildScript],
    ['--tsconfig', tsconfig],
    ['--workspace', workspace],
  ]) {
    if (value !== undefined && value.length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }
  if (patterns.length === 0) {
    throw new Error(
      'usage: node scripts/run-workspace-node-tests.mjs [options] <glob>...',
    );
  }

  return {
    coverageOutput,
    jobs: parsedJobs,
    patterns,
    postBuildScript,
    tsconfig,
    workspace,
  };
}

async function runBuildCommand(command, args, options) {
  const ownedChild = spawnOwnedChildProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  options.setActiveChild(ownedChild);
  try {
    const result = await ownedChild.waitForExit();
    try {
      await ownedChild.settleTree();
    } catch (error) {
      options.markSettlementUnsafe(error);
      throw error;
    }
    await ownedChild.waitForClose();
    if (result.error !== undefined) {
      throw result.error;
    }
    return result;
  } finally {
    options.setActiveChild(undefined);
  }
}

function hasErrorCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function parseWorkspaceTestBuildCacheOwner(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.hostname !== 'string' ||
    value.hostname.length === 0 ||
    typeof value.ownerId !== 'string' ||
    value.ownerId.length === 0
  ) {
    return null;
  }
  return value;
}

async function readWorkspaceTestBuildCacheLock(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    throw error;
  }

  try {
    const owner = parseWorkspaceTestBuildCacheOwner(JSON.parse(raw));
    return owner ? { kind: 'owner', owner } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

async function releaseWorkspaceTestBuildCache(lockPath, ownerId) {
  const current = await readWorkspaceTestBuildCacheLock(lockPath);
  if (current.kind === 'owner' && current.owner.ownerId === ownerId) {
    await rm(lockPath, { force: true });
  }
}

async function tryCreateWorkspaceTestBuildCacheLock(lockPath, owner) {
  const preparedPath = `${lockPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(preparedPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(preparedPath, lockPath);
      return true;
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(preparedPath, { force: true });
  }
}

async function acquireWorkspaceTestBuildCache(cwd) {
  const cacheRoot = resolve(cwd, workspaceTestBuildCacheDirectory);
  const lockPath = resolve(cwd, workspaceTestBuildCacheLock);
  const owner = {
    hostname: hostname(),
    ownerId: randomUUID(),
    pid: process.pid,
  };

  try {
    for (;;) {
      if (await tryCreateWorkspaceTestBuildCacheLock(lockPath, owner)) {
        return {
          cacheRoot,
          release: () =>
            releaseWorkspaceTestBuildCache(lockPath, owner.ownerId),
        };
      }

      const current = await readWorkspaceTestBuildCacheLock(lockPath);
      if (current.kind === 'missing') {
        continue;
      }
      if (current.kind === 'invalid') {
        console.warn(
          `test build cache -> invalid lock at ${lockPath}; using isolated compilation`,
        );
        return null;
      }
      if (
        current.owner.hostname === owner.hostname &&
        !isProcessAlive(current.owner.pid)
      ) {
        await releaseWorkspaceTestBuildCache(lockPath, current.owner.ownerId);
        continue;
      }

      console.log(
        `test build cache -> busy (${current.owner.pid}@${current.owner.hostname}); using isolated compilation`,
      );
      return null;
    }
  } catch (error) {
    console.warn(
      `test build cache -> unavailable; using isolated compilation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function readTypeScriptBuildInfo(buildInfoPath) {
  let raw;
  try {
    raw = await readFile(buildInfoPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'string' ||
      !Array.isArray(parsed.fileNames) ||
      parsed.fileNames.some((fileName) => typeof fileName !== 'string') ||
      !parsed.options ||
      typeof parsed.options !== 'object' ||
      Array.isArray(parsed.options)
    ) {
      return null;
    }
    return {
      fileNames: parsed.fileNames,
      options: parsed.options,
      version: parsed.version,
    };
  } catch {
    return null;
  }
}

function requiresFreshWorkspaceTestBuild(previous, current) {
  if (
    previous.version !== current.version ||
    JSON.stringify(previous.options) !== JSON.stringify(current.options)
  ) {
    return true;
  }
  const currentFileNames = new Set(current.fileNames);
  return previous.fileNames.some((fileName) => !currentFileNames.has(fileName));
}

async function copyWorkspaceTestBuildSnapshot(cacheRoot, testRoot) {
  const entries = await readdir(cacheRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const entryPath = (entry) => resolve(entry.parentPath, entry.name);
  const snapshotPath = (entry) =>
    resolve(testRoot, relative(cacheRoot, entryPath(entry)));
  const unsupportedEntries = entries.filter(
    (entry) =>
      !entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink(),
  );
  if (unsupportedEntries.length > 0) {
    throw new Error(
      `test build cache contains unsupported entries: ${unsupportedEntries.map((entry) => relative(cacheRoot, entryPath(entry))).join(', ')}`,
    );
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => mkdir(snapshotPath(entry), { recursive: true })),
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        copyFile(
          entryPath(entry),
          snapshotPath(entry),
          fsConstants.COPYFILE_FICLONE,
        ),
      ),
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isSymbolicLink())
      .map(async (entry) =>
        symlink(await readlink(entryPath(entry)), snapshotPath(entry)),
      ),
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isEmptyCompiledEsmModule(source) {
  const executableSource = source
    .replace(/^#![^\n]*(?:\n|$)/u, '')
    .replace(/^\s*\/\/# sourceMappingURL=.*(?:\r?\n|$)/gmu, '')
    .trim();
  return executableSource === '' || executableSource === 'export {};';
}

async function buildCoverageExcludeArgs(options) {
  const entries = await readdir(options.testRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const emptyModuleExcludes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }
    const filePath = resolve(entry.parentPath, entry.name);
    if (isEmptyCompiledEsmModule(await readFile(filePath, 'utf8'))) {
      emptyModuleExcludes.push(
        relative(options.cwd, filePath).replaceAll('\\', '/'),
      );
    }
  }
  if (emptyModuleExcludes.length === 0) {
    return [];
  }

  const packageJson = JSON.parse(
    await readFile(resolve(options.cwd, 'package.json'), 'utf8'),
  );
  const configuredExcludes = packageJson?.c8?.exclude;
  if (configuredExcludes === undefined) {
    return [];
  }
  const inheritedExcludes = Array.isArray(configuredExcludes)
    ? configuredExcludes
    : typeof configuredExcludes === 'string'
      ? [configuredExcludes]
      : null;
  if (
    inheritedExcludes === null ||
    inheritedExcludes.some((exclude) => typeof exclude !== 'string')
  ) {
    throw new Error('package.json c8.exclude must be a string or string array');
  }
  return [...inheritedExcludes, ...emptyModuleExcludes].flatMap((exclude) => [
    '--exclude',
    exclude,
  ]);
}

async function runCoverageTests(parsed, runnerArgs, options) {
  const rawCoverageDirectory = resolve(options.testRoot, 'coverage-tmp');
  const stagedReportDirectory = resolve(options.testRoot, 'coverage-report');
  const coverageExcludeArgs = await buildCoverageExcludeArgs(options);
  const coverageResult = await runBuildCommand(
    process.execPath,
    [
      options.coverageCli,
      ...coverageExcludeArgs,
      '--temp-directory',
      rawCoverageDirectory,
      '--reports-dir',
      stagedReportDirectory,
      '--src',
      options.testRoot,
      process.execPath,
      nodeTestRunnerCli,
      ...runnerArgs,
    ],
    options,
  );

  if (!options.wasInterrupted() && (await pathExists(stagedReportDirectory))) {
    const publishRoot = resolve(options.cwd, parsed.coverageOutput);
    const reportName = `${basename(options.testRoot)}${coverageResult.code === 0 ? '' : '-failed'}`;
    const publishedReportDirectory = resolve(publishRoot, reportName);
    await mkdir(publishRoot, { recursive: true });
    await rename(stagedReportDirectory, publishedReportDirectory);
    console.log(
      coverageResult.code === 0
        ? `Coverage report: ${publishedReportDirectory}`
        : `Coverage diagnostic report (failed run): ${publishedReportDirectory}`,
    );
  }

  return coverageResult.code;
}

async function compileWorkspaceTestBuild(parsed, options, outputRoot) {
  const compileResult = await runBuildCommand(
    process.execPath,
    [
      typescriptCli,
      '-p',
      resolve(options.cwd, parsed.tsconfig),
      '--outDir',
      outputRoot,
      '--tsBuildInfoFile',
      resolve(outputRoot, workspaceTestBuildInfoFile),
    ],
    options,
  );
  if (compileResult.code !== 0 || compileResult.signal !== null) {
    return compileResult.code;
  }

  return 0;
}

async function runWorkspaceTestPostBuild(parsed, options, outputRoot) {
  if (parsed.postBuildScript) {
    const postBuildResult = await runBuildCommand(
      process.execPath,
      [resolve(options.cwd, parsed.postBuildScript), basename(outputRoot)],
      options,
    );
    if (postBuildResult.code !== 0 || postBuildResult.signal !== null) {
      return postBuildResult.code;
    }
  }

  return 0;
}

async function buildIsolatedWorkspaceTestOutput(parsed, options) {
  const compileCode = await compileWorkspaceTestBuild(
    parsed,
    options,
    options.testRoot,
  );
  if (compileCode !== 0) {
    return compileCode;
  }
  return runWorkspaceTestPostBuild(parsed, options, options.testRoot);
}

async function prepareWorkspaceTestBuild(parsed, options) {
  const cache = await acquireWorkspaceTestBuildCache(options.cwd);
  if (cache === null) {
    return buildIsolatedWorkspaceTestOutput(parsed, options);
  }

  try {
    const buildInfoPath = resolve(cache.cacheRoot, workspaceTestBuildInfoFile);
    const previousBuildInfo = await readTypeScriptBuildInfo(buildInfoPath);
    if (previousBuildInfo === null && (await pathExists(cache.cacheRoot))) {
      await rm(cache.cacheRoot, { recursive: true, force: true });
    }

    let compileCode = await compileWorkspaceTestBuild(
      parsed,
      options,
      cache.cacheRoot,
    );
    if (compileCode !== 0) {
      return compileCode;
    }

    const currentBuildInfo = await readTypeScriptBuildInfo(buildInfoPath);
    if (
      previousBuildInfo !== null &&
      (currentBuildInfo === null ||
        requiresFreshWorkspaceTestBuild(previousBuildInfo, currentBuildInfo))
    ) {
      console.log(
        'test build cache -> build metadata, source set, or compiler options changed; rebuilding fresh',
      );
      await rm(cache.cacheRoot, { recursive: true, force: true });
      compileCode = await compileWorkspaceTestBuild(
        parsed,
        options,
        cache.cacheRoot,
      );
      if (compileCode !== 0) {
        return compileCode;
      }
    }

    const postBuildCode = await runWorkspaceTestPostBuild(
      parsed,
      options,
      cache.cacheRoot,
    );
    if (postBuildCode !== 0) {
      return postBuildCode;
    }
    await copyWorkspaceTestBuildSnapshot(cache.cacheRoot, options.testRoot);
    return 0;
  } finally {
    await cache.release();
  }
}

export async function runWorkspaceNodeTests(
  args = process.argv.slice(2),
  {
    coverageCli = c8Cli,
    cwd = process.cwd(),
    env = process.env,
    runTests = runNodeTests,
  } = {},
) {
  let parsed;
  try {
    parsed = parseWorkspaceTestArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let testRoot;
  let activeChild;
  let cleanupSafe = true;
  let interrupted = false;
  const setActiveChild = (child) => {
    activeChild = child;
  };
  const onSignal = (signal) => {
    interrupted = true;
    if (activeChild !== undefined) {
      void activeChild.terminateTree(signal).catch(() => {});
    }
  };
  const markSettlementUnsafe = (error) => {
    cleanupSafe = false;
    console.error(
      `Process tree settlement failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  };
  const signalHandlers = [
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  try {
    testRoot = await mkdtemp(resolve(cwd, 'dist-test-run-'));
    if (interrupted) {
      return 130;
    }
    const buildCode = await prepareWorkspaceTestBuild(parsed, {
      cwd,
      env,
      markSettlementUnsafe,
      setActiveChild,
      testRoot,
    });
    if (interrupted) {
      return 130;
    }
    if (buildCode !== 0) {
      return buildCode;
    }

    const runnerArgs = [
      ...(parsed.jobs === undefined ? [] : [`--jobs=${parsed.jobs}`]),
      '--test-root',
      basename(testRoot),
      ...(parsed.workspace ? ['--workspace', parsed.workspace] : []),
      ...parsed.patterns,
    ];
    const result =
      parsed.coverageOutput === undefined
        ? await runTests(runnerArgs, {
            cwd,
            env,
            onUnsafeSettlement: markSettlementUnsafe,
          })
        : await runCoverageTests(parsed, runnerArgs, {
            coverageCli,
            cwd,
            env,
            markSettlementUnsafe,
            setActiveChild,
            testRoot,
            wasInterrupted: () => interrupted,
          });
    if (!cleanupSafe) {
      return 2;
    }
    return interrupted ? 130 : result;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    if (testRoot !== undefined) {
      if (cleanupSafe) {
        await rm(testRoot, { recursive: true, force: true });
      } else {
        console.error(
          `Preserved invocation output because process tree settlement was not proven: ${testRoot}`,
        );
      }
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runWorkspaceNodeTests();
}
