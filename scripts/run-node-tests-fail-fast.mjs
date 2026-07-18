#!/usr/bin/env node
/**
 * Process-isolated, bounded-concurrency node:test runner.
 *
 * Each test file is still a separate OS process. The outer scheduler only
 * controls how many files are active at once and keeps evidence-backed host
 * resource lanes serial.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, globSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  priorityTestFilesForWorkspace,
  serialTestLanesForWorkspace,
} from './node-test-lanes.mjs';
import { spawnOwnedChildProcess } from './owned-child-process.mjs';

const TEST_FILE_GLOB_MARKERS = /[*?{}[\]]/;

export function parseRunnerArgs(args) {
  const patterns = [];
  let jobs;
  let testRoot;
  let workspace;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      patterns.push(...args.slice(index + 1));
      break;
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
    if (argument === '--test-root') {
      testRoot = args[index + 1];
      if (testRoot === undefined) {
        throw new Error('--test-root requires a value');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--test-root=')) {
      testRoot = argument.slice('--test-root='.length);
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
      throw new Error(`unknown runner option: ${argument}`);
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
  if (patterns.length === 0) {
    throw new Error(
      'usage: node scripts/run-node-tests-fail-fast.mjs [options] <glob>...',
    );
  }
  if (testRoot !== undefined && testRoot.length === 0) {
    throw new Error('--test-root must not be empty');
  }
  if (workspace !== undefined && workspace.length === 0) {
    throw new Error('--workspace must not be empty');
  }

  return { jobs: parsedJobs, patterns, testRoot, workspace };
}

export function expandTestFiles(patterns, cwd = process.cwd()) {
  const files = new Set();
  for (const pattern of patterns) {
    const matches = globSync(pattern, {
      cwd,
      windowsPathsNoEscape: true,
    });
    if (matches.length === 0) {
      const candidate = resolve(cwd, pattern);
      if (TEST_FILE_GLOB_MARKERS.test(pattern) || !existsSync(candidate)) {
        throw new Error(`no test files matched: ${pattern}`);
      }
      files.add(candidate);
      continue;
    }
    for (const match of matches) {
      files.add(resolve(cwd, match));
    }
  }
  return [...files].sort();
}

function normalizePath(value) {
  return value.split(sep).join('/');
}

function relativePathInside(root, file) {
  const candidate = relative(root, file);
  if (
    candidate === '..' ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new Error(`test file escapes configured test root: ${file}`);
  }
  return normalizePath(candidate);
}

function relativeTestPath(file, cwd, testRoot = cwd) {
  if (resolve(testRoot) === resolve(cwd)) {
    return relativePathInside(cwd, file);
  }
  return `dist-test/${relativePathInside(testRoot, file)}`;
}

function resolveConfiguredTestPath(laneFile, cwd, testRoot) {
  const normalizedLaneFile = normalizePath(laneFile).replace(/^\.\//, '');
  if (resolve(testRoot) === resolve(cwd)) {
    return resolve(cwd, normalizedLaneFile);
  }
  if (!normalizedLaneFile.startsWith('dist-test/')) {
    throw new Error(
      `test lane path must use the canonical dist-test prefix: ${laneFile}`,
    );
  }
  return resolve(testRoot, normalizedLaneFile.slice('dist-test/'.length));
}

function pathMatchesLaneFile(file, laneFile, cwd, testRoot) {
  const candidate = relativeTestPath(file, cwd, testRoot);
  const normalizedLaneFile = normalizePath(laneFile).replace(/^\.\//, '');
  return candidate === normalizedLaneFile;
}

export function validateSerialTestLanes(
  lanes,
  { cwd = process.cwd(), testRoot = cwd } = {},
) {
  const names = new Set();
  const files = new Set();
  for (const lane of lanes) {
    if (
      !lane ||
      typeof lane.name !== 'string' ||
      lane.name.length === 0 ||
      !Array.isArray(lane.files) ||
      lane.files.length === 0
    ) {
      throw new Error(
        'serial test lane must have a name and at least one file',
      );
    }
    if (names.has(lane.name)) {
      throw new Error(`duplicate serial test lane: ${lane.name}`);
    }
    names.add(lane.name);
    for (const laneFile of lane.files) {
      if (typeof laneFile !== 'string' || laneFile.length === 0) {
        throw new Error(`invalid file in serial test lane ${lane.name}`);
      }
      const normalizedLaneFile = normalizePath(laneFile).replace(/^\.\//, '');
      if (files.has(normalizedLaneFile)) {
        throw new Error(
          `test file appears in multiple serial lanes: ${laneFile}`,
        );
      }
      files.add(normalizedLaneFile);
      if (!existsSync(resolveConfiguredTestPath(laneFile, cwd, testRoot))) {
        throw new Error(
          `stale serial test lane entry: ${lane.name}/${laneFile}`,
        );
      }
    }
  }
}

export function classifyTestFiles(
  files,
  lanes,
  { cwd = process.cwd(), testRoot = cwd } = {},
) {
  const laneByFile = new Map();
  for (const file of files) {
    const matches = lanes.filter((lane) =>
      lane.files.some((laneFile) =>
        pathMatchesLaneFile(file, laneFile, cwd, testRoot),
      ),
    );
    if (matches.length > 1) {
      throw new Error(
        `test file matches multiple serial lanes: ${relativeTestPath(file, cwd, testRoot)}`,
      );
    }
    laneByFile.set(file, matches[0]?.name ?? null);
  }
  return laneByFile;
}

export function prioritizeTestFiles(
  files,
  priorityFiles,
  { cwd = process.cwd(), testRoot = cwd } = {},
) {
  const priorityByPath = new Map(
    priorityFiles.map((file, index) => [
      normalizePath(file).replace(/^\.\//, ''),
      index,
    ]),
  );
  return [...files].sort((left, right) => {
    const leftPriority = priorityByPath.get(
      relativeTestPath(left, cwd, testRoot),
    );
    const rightPriority = priorityByPath.get(
      relativeTestPath(right, cwd, testRoot),
    );
    if (leftPriority !== undefined || rightPriority !== undefined) {
      return (
        (leftPriority ?? Number.POSITIVE_INFINITY) -
        (rightPriority ?? Number.POSITIVE_INFINITY)
      );
    }
    return left.localeCompare(right);
  });
}

export function resolveDefaultJobs(
  env = process.env,
  detectedParallelism = availableParallelism?.() ?? 2,
) {
  const configured = env['GEULBAT_TEST_JOBS'];
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `GEULBAT_TEST_JOBS must be a positive integer, received: ${configured}`,
      );
    }
    return parsed;
  }
  return Math.max(1, detectedParallelism);
}

async function runTestFile(
  file,
  { cwd, env, outputDirectory, activeChildren, onUnsafeSettlement },
) {
  const fileId = createHash('sha256').update(file).digest('hex');
  const logPath = resolve(outputDirectory, `${fileId}.log`);
  const log = createWriteStream(logPath);
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST_')) {
      delete childEnv[key];
    }
  }
  const ownedChild = spawnOwnedChildProcess(
    process.execPath,
    [
      '--test',
      '--test-force-exit',
      '--test-isolation=none',
      '--test-reporter=spec',
      file,
    ],
    { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const { child } = ownedChild;
  activeChildren.add(ownedChild);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  const result = await ownedChild.waitForExit();

  let settlementError;
  try {
    await ownedChild.settleTree();
  } catch (error) {
    settlementError = error;
    onUnsafeSettlement(error);
  } finally {
    activeChildren.delete(ownedChild);
  }

  if (settlementError === undefined) {
    await ownedChild.waitForClose();
  }
  child.stdout.unpipe(log);
  child.stderr.unpipe(log);
  if (settlementError !== undefined) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await new Promise((resolveLog) => log.end(resolveLog));

  return {
    ...result,
    ...(settlementError === undefined ? {} : { code: 1, settlementError }),
    file,
    logPath,
    output: await readFile(logPath, 'utf8'),
  };
}

function printResult(result, cwd, testRoot) {
  const label = `\n▶ ${relativeTestPath(result.file, cwd, testRoot)}`;
  const stream = result.code === 0 ? process.stdout : process.stderr;
  stream.write(`${label}\n${result.output}`);
  if (result.output.length > 0 && !result.output.endsWith('\n')) {
    stream.write('\n');
  }
  if (result.error !== undefined) {
    stream.write(
      `Test process failed to start: ${result.error instanceof Error ? (result.error.stack ?? result.error.message) : String(result.error)}\n`,
    );
  }
  if (result.settlementError !== undefined) {
    stream.write(
      `Process tree settlement failed: ${result.settlementError instanceof Error ? (result.settlementError.stack ?? result.settlementError.message) : String(result.settlementError)}\n`,
    );
  }
}

async function runPhase(files, options) {
  if (files.length === 0) {
    return { failures: [], interrupted: false };
  }

  const results = new Array(files.length);
  let nextIndex = 0;

  const worker = async () => {
    while (!options.scheduler.stopScheduling) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) {
        return;
      }
      const release = await options.scheduler.gate.acquire();
      if (options.scheduler.stopScheduling) {
        release();
        return;
      }
      let result;
      try {
        result = await options.runFile(files[index], {
          cwd: options.cwd,
          env: options.env,
          outputDirectory: options.outputDirectory,
          activeChildren: options.scheduler.activeChildren,
          onUnsafeSettlement: options.onUnsafeSettlement,
        });
      } finally {
        release();
      }
      results[index] = result;
      if (result.code !== 0) {
        options.scheduler.stopScheduling = true;
        printResult(result, options.cwd, options.testRoot);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.jobs, files.length) }, () =>
      worker(),
    ),
  );
  const failures = results.filter((result) => result?.code !== 0);
  for (const result of results) {
    if (result && result.code === 0) {
      printResult(result, options.cwd, options.testRoot);
    }
  }
  return { failures };
}

function createConcurrencyGate(limit) {
  let active = 0;
  const waiters = [];
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next(release);
    }
  };
  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise((resolveAcquire) => waiters.push(resolveAcquire));
    },
  };
}

export async function runTestFiles(
  files,
  {
    cwd = process.cwd(),
    env = process.env,
    jobs = resolveDefaultJobs(),
    lanes = [],
    outputRoot = tmpdir(),
    priorityFiles = [],
    runFile = runTestFile,
    testRoot = cwd,
    onUnsafeSettlement = () => {},
  } = {},
) {
  validateSerialTestLanes(lanes, { cwd, testRoot });
  const laneByFile = classifyTestFiles(files, lanes, { cwd, testRoot });
  const outputDirectory = await mkdtemp(
    resolve(outputRoot, 'geulbat-node-tests-'),
  );
  const failures = [];
  let interrupted = false;
  const scheduler = {
    activeChildren: new Set(),
    gate: createConcurrencyGate(jobs),
    stopScheduling: false,
  };
  let settlementSafe = true;
  const recordUnsafeSettlement = (error) => {
    settlementSafe = false;
    onUnsafeSettlement(error);
  };
  const onSignal = (signal) => {
    interrupted = true;
    scheduler.stopScheduling = true;
    for (const child of scheduler.activeChildren) {
      void child.terminateTree(signal).catch(() => {});
    }
  };
  const signalHandlers = [
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }
  try {
    const parallelFiles = prioritizeTestFiles(
      files.filter((file) => laneByFile.get(file) === null),
      priorityFiles,
      { cwd, testRoot },
    );
    const phasePromises = [
      ...lanes.map((lane) =>
        runPhase(
          files.filter((file) => laneByFile.get(file) === lane.name).sort(),
          {
            cwd,
            env,
            jobs: 1,
            outputDirectory,
            onUnsafeSettlement: recordUnsafeSettlement,
            runFile,
            scheduler,
            testRoot,
          },
        ),
      ),
      runPhase(parallelFiles, {
        cwd,
        env,
        jobs,
        outputDirectory,
        onUnsafeSettlement: recordUnsafeSettlement,
        runFile,
        scheduler,
        testRoot,
      }),
    ];
    const phaseResults = await Promise.all(phasePromises);
    for (const phaseResult of phaseResults) {
      failures.push(...phaseResult.failures);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    if (settlementSafe) {
      await rm(outputDirectory, { recursive: true, force: true });
    } else {
      console.error(
        `Preserved runner diagnostics because process-tree settlement was not proven: ${outputDirectory}`,
      );
    }
  }
  return { failures, interrupted, settlementSafe };
}

export async function main(
  args = process.argv.slice(2),
  {
    cwd = process.cwd(),
    env = process.env,
    onUnsafeSettlement = () => {},
  } = {},
) {
  let parsed;
  try {
    parsed = parseRunnerArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let files;
  try {
    const testRoot = resolve(cwd, parsed.testRoot ?? '.');
    files = expandTestFiles(parsed.patterns, testRoot);
    const workspace = parsed.workspace ?? basename(cwd);
    const lanes = serialTestLanesForWorkspace(workspace);
    const priorityFiles = priorityTestFilesForWorkspace(workspace);
    const result = await runTestFiles(files, {
      cwd,
      env,
      jobs: parsed.jobs ?? resolveDefaultJobs(env),
      lanes,
      priorityFiles,
      testRoot,
      onUnsafeSettlement,
    });
    if (!result.settlementSafe) {
      console.error(
        'Process tree settlement failed; invocation-owned files must be preserved.',
      );
      return 2;
    }
    if (result.interrupted) {
      return 130;
    }
    if (result.failures.length > 0) {
      console.error(
        `FAIL-FAST: ${result.failures.length} test file(s) failed; queued files were not started`,
      );
      return result.failures[0].code || 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
