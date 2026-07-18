import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { connect } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalDevAuthEnv } from '../../../scripts/local-dev-auth-token.mjs';
import {
  createDaemonDevBundleBuilder,
  getDaemonDevWatchRoots,
} from './dev-daemon-bundle.mjs';

const daemonRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(daemonRoot, '../..');
const daemonSourceRoots = getDaemonDevWatchRoots(repoRoot);
const sourceFilePattern = /\.(?:[cm]?ts|tsx)$/u;
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/u;
const ignoredDirectoryNames = new Set(['__tests__', 'test-support', 'tests']);
const DEFAULT_DAEMON_PORT = 3_456;
const DEFAULT_WATCH_POLLING_INTERVAL_MS = 5_000;

function relativePathWithinSourceRoots(sourceRoots, candidatePath) {
  for (const sourceRoot of sourceRoots) {
    const relativePath = relative(sourceRoot, resolve(candidatePath));
    if (
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    ) {
      return relativePath;
    }
  }
  return null;
}

function isDaemonRuntimeSourcePath(sourceRoots, candidatePath) {
  const relativePath = relativePathWithinSourceRoots(
    sourceRoots,
    candidatePath,
  );
  if (relativePath === null || relativePath === '') {
    return false;
  }
  const segments = relativePath.split(sep);
  return (
    !segments.some((segment) => ignoredDirectoryNames.has(segment)) &&
    sourceFilePattern.test(relativePath) &&
    !testFilePattern.test(relativePath)
  );
}

function readBooleanEnv(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function readPositiveIntegerEnv(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${key}: expected positive integer`);
  }
  return parsed;
}

function readDevPort(env) {
  const port = readPositiveIntegerEnv(env, 'PORT', DEFAULT_DAEMON_PORT);
  if (port > 65_535) {
    throw new Error('invalid PORT: expected integer between 1 and 65535');
  }
  return port;
}

function connectHostForBindHost(host) {
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (host === '::') {
    return '::1';
  }
  return host;
}

export async function assertDaemonDevPortAvailable({
  env = process.env,
  createConnection = connect,
} = {}) {
  const port = readDevPort(env);
  const host = connectHostForBindHost(env.HOST ?? '127.0.0.1');
  await new Promise((resolveAvailable, rejectUnavailable) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      rejectUnavailable(
        new Error(
          `daemon development port ${host}:${port} is already in use; stop the existing daemon before starting another one`,
        ),
      );
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error?.code === 'ECONNREFUSED') {
        resolveAvailable();
        return;
      }
      rejectUnavailable(error);
    });
  });
}

export async function createDaemonSourceWatcher({
  sourceRoots = daemonSourceRoots,
  onChange,
  onError,
  loadChokidar = () => import('chokidar'),
  usePolling = true,
  pollingIntervalMs = DEFAULT_WATCH_POLLING_INTERVAL_MS,
  awaitReady = true,
}) {
  const { watch } = await loadChokidar();
  const watcher = watch(sourceRoots, {
    ignoreInitial: true,
    usePolling,
    interval: pollingIntervalMs,
    ignored: (candidatePath, stats) => {
      const relativePath = relativePathWithinSourceRoots(
        sourceRoots,
        candidatePath,
      );
      if (relativePath === null) {
        return true;
      }
      const segments = relativePath.split(sep);
      if (segments.some((segment) => ignoredDirectoryNames.has(segment))) {
        return true;
      }
      return stats?.isFile() === true
        ? !isDaemonRuntimeSourcePath(sourceRoots, candidatePath)
        : false;
    },
  });

  watcher.on('all', (eventName, candidatePath) => {
    if (isDaemonRuntimeSourcePath(sourceRoots, candidatePath)) {
      onChange({ eventName, path: candidatePath });
    }
  });
  watcher.on('error', onError);

  if (!awaitReady) {
    return watcher;
  }

  try {
    await new Promise((resolveReady, rejectReady) => {
      const handleReady = () => {
        watcher.off('error', handleInitialError);
        resolveReady();
      };
      const handleInitialError = (error) => {
        watcher.off('ready', handleReady);
        rejectReady(error);
      };
      watcher.once('ready', handleReady);
      watcher.once('error', handleInitialError);
    });
  } catch (error) {
    await watcher.close();
    throw error;
  }

  return watcher;
}

export function waitForChildClose(child) {
  return new Promise((resolveClose) => {
    child.once('close', (code, signal) => {
      resolveClose({ code, signal });
    });
  });
}

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function exitCodeForUnexpectedClose({ code, signal }) {
  if (typeof code === 'number' && code !== 0) {
    return code;
  }
  return signal === null ? 1 : exitCodeForSignal(signal);
}

function describeUnexpectedClose({ code, signal }) {
  if (signal !== null) {
    return `daemon child closed unexpectedly after ${signal}`;
  }
  return `daemon child closed unexpectedly with code ${String(code)}`;
}

function resolveDaemonSpawnSpec({ cwd, env, devBundleEntryPath }) {
  const useDist = readBooleanEnv(env, 'GEULBAT_DEV_USE_DIST', false);
  const distEntry = resolve(cwd, 'dist/index.js');
  if (useDist) {
    if (!existsSync(distEntry)) {
      throw new Error(
        `GEULBAT_DEV_USE_DIST=1 but missing ${distEntry}. Run \`npm run build -w apps/daemon\` first.`,
      );
    }
    return {
      mode: 'dist',
      args: [distEntry],
    };
  }
  return {
    mode: 'development-bundle',
    args: [devBundleEntryPath],
  };
}

function spawnDaemonProcess({ cwd, env, spec }) {
  return spawn(process.execPath, spec.args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
    detached: false,
  });
}

function logSupervisor(message) {
  console.error(`[daemon-dev-supervisor] ${message}`);
}

export async function runDaemonDevSupervisor({
  root = daemonRoot,
  sourceRoots = getDaemonDevWatchRoots(resolve(root, '../..')),
  baseEnv = process.env,
  createWatcher = createDaemonSourceWatcher,
  createBundleBuilder = createDaemonDevBundleBuilder,
  assertPortAvailable = assertDaemonDevPortAvailable,
  spawnDaemon = spawnDaemonProcess,
  signalSource = process,
  reportError = (error) => console.error('[daemon-dev-supervisor]', error),
  reportInfo = logSupervisor,
} = {}) {
  const childEnv = createLocalDevAuthEnv(baseEnv);
  const noWatch = readBooleanEnv(childEnv, 'GEULBAT_DEV_NO_WATCH', false);
  const usePolling = readBooleanEnv(
    childEnv,
    'GEULBAT_DEV_WATCH_POLLING',
    true,
  );
  const pollingIntervalMs = readPositiveIntegerEnv(
    childEnv,
    'GEULBAT_DEV_WATCH_INTERVAL_MS',
    DEFAULT_WATCH_POLLING_INTERVAL_MS,
  );
  const useDist = readBooleanEnv(childEnv, 'GEULBAT_DEV_USE_DIST', false);
  let watcher;
  let bundleBuilder;
  let bundleBuilderPromise;
  let activeChild;
  let requestedGeneration = 0;
  let appliedGeneration = 0;
  let restartRunning = false;
  let restartScheduled = false;
  let terminationPromise;

  let resolveCompletion;
  const completion = new Promise((resolveResult) => {
    resolveCompletion = resolveResult;
  });

  const removeSignalHandlers = () => {
    signalSource.off('SIGINT', handleSigint);
    signalSource.off('SIGTERM', handleSigterm);
  };

  const closeActiveChild = async (record, signal) => {
    if (record.closeResult !== undefined) {
      return record.closeResult;
    }
    if (!record.expectedClose) {
      record.expectedClose = true;
      record.child.kill(signal);
    }
    return record.closed;
  };

  const terminate = (exitCode, childSignal, error) => {
    if (terminationPromise !== undefined) {
      const childToClose = activeChild;
      if (
        childToClose !== undefined &&
        childToClose.closeResult === undefined &&
        !childToClose.expectedClose
      ) {
        childToClose.expectedClose = true;
        childToClose.child.kill(childSignal);
      }
      return terminationPromise;
    }

    if (error !== undefined) {
      reportError(error);
    }

    terminationPromise = (async () => {
      const closeWatcher = watcher?.close() ?? Promise.resolve();
      const closeChild =
        activeChild === undefined
          ? Promise.resolve()
          : closeActiveChild(activeChild, childSignal);
      const closeBundleBuilder =
        bundleBuilderPromise?.then((builder) => builder.dispose()) ??
        Promise.resolve();

      const [watcherResult, childResult, bundleBuilderResult] =
        await Promise.allSettled([
          closeWatcher,
          closeChild,
          closeBundleBuilder,
        ]);
      let finalExitCode = exitCode;
      if (watcherResult.status === 'rejected') {
        reportError(watcherResult.reason);
        finalExitCode = 1;
      }
      if (childResult.status === 'rejected') {
        reportError(childResult.reason);
        finalExitCode = 1;
      }
      if (bundleBuilderResult.status === 'rejected') {
        reportError(bundleBuilderResult.reason);
        finalExitCode = 1;
      }

      removeSignalHandlers();
      resolveCompletion(finalExitCode);
    })();
    return terminationPromise;
  };

  function handleSigint() {
    void terminate(exitCodeForSignal('SIGINT'), 'SIGINT');
  }

  function handleSigterm() {
    void terminate(exitCodeForSignal('SIGTERM'), 'SIGTERM');
  }

  const prepareSpawnSpec = async () => {
    if (!useDist) {
      bundleBuilderPromise ??= createBundleBuilder({
        root: resolve(root, '../..'),
        appRoot: root,
        reportInfo,
      });
      bundleBuilder = await bundleBuilderPromise;
      if (terminationPromise !== undefined) {
        return undefined;
      }
      await bundleBuilder.rebuild();
    }

    return resolveDaemonSpawnSpec({
      cwd: root,
      env: childEnv,
      devBundleEntryPath:
        bundleBuilder?.entryPath ?? resolve(root, 'dist-dev/index.mjs'),
    });
  };

  const launchChild = (spawnSpec) => {
    reportInfo(
      `spawning daemon (${spawnSpec.mode}): node ${spawnSpec.args.join(' ')}`,
    );
    const child = spawnDaemon({ cwd: root, env: childEnv, spec: spawnSpec });
    const record = {
      child,
      closed: waitForChildClose(child),
      closeResult: undefined,
      expectedClose: false,
    };
    activeChild = record;

    child.once('error', (error) => {
      if (!record.expectedClose && terminationPromise === undefined) {
        void terminate(1, 'SIGTERM', error);
      }
    });
    void record.closed.then((result) => {
      record.closeResult = result;
      if (activeChild === record) {
        activeChild = undefined;
      }
      if (!record.expectedClose && terminationPromise === undefined) {
        void terminate(
          exitCodeForUnexpectedClose(result),
          'SIGTERM',
          new Error(describeUnexpectedClose(result)),
        );
      }
    });
  };

  const reconcileRestarts = async () => {
    if (restartRunning || terminationPromise !== undefined) {
      return;
    }
    restartRunning = true;
    try {
      while (
        terminationPromise === undefined &&
        appliedGeneration < requestedGeneration
      ) {
        const generationToApply = requestedGeneration;
        const spawnSpec = await prepareSpawnSpec();
        if (terminationPromise !== undefined || spawnSpec === undefined) {
          return;
        }
        const childToReplace = activeChild;
        if (childToReplace === undefined) {
          return;
        }
        await closeActiveChild(childToReplace, 'SIGTERM');
        if (terminationPromise !== undefined) {
          return;
        }
        launchChild(spawnSpec);
        appliedGeneration = generationToApply;
      }
    } catch (error) {
      await terminate(1, 'SIGTERM', error);
    } finally {
      restartRunning = false;
      if (
        terminationPromise === undefined &&
        appliedGeneration < requestedGeneration
      ) {
        void reconcileRestarts();
      }
    }
  };

  const requestRestart = () => {
    if (terminationPromise !== undefined) {
      return;
    }
    requestedGeneration += 1;
    if (restartRunning || restartScheduled) {
      return;
    }
    restartScheduled = true;
    queueMicrotask(() => {
      restartScheduled = false;
      void reconcileRestarts();
    });
  };

  try {
    signalSource.on('SIGINT', handleSigint);
    signalSource.on('SIGTERM', handleSigterm);
    await assertPortAvailable({ env: childEnv });
    const initialSpawnSpec = await prepareSpawnSpec();
    if (terminationPromise !== undefined || initialSpawnSpec === undefined) {
      return completion;
    }
    launchChild(initialSpawnSpec);
    appliedGeneration = requestedGeneration;

    if (noWatch) {
      reportInfo('watch disabled (GEULBAT_DEV_NO_WATCH=1)');
      return completion;
    }

    reportInfo(
      `starting source watcher (polling=${usePolling ? `on, ${pollingIntervalMs}ms` : 'off'}; ready is non-blocking)`,
    );
    void createWatcher({
      sourceRoots,
      usePolling,
      pollingIntervalMs,
      // Do not block the first boot on watcher readiness.
      awaitReady: false,
      onChange: requestRestart,
      onError: (error) => {
        void terminate(1, 'SIGTERM', error);
      },
    })
      .then((createdWatcher) => {
        if (terminationPromise !== undefined) {
          return createdWatcher.close();
        }
        watcher = createdWatcher;
        reportInfo('source watcher active');
        return undefined;
      })
      .catch((error) => {
        void terminate(1, 'SIGTERM', error);
      });
  } catch (error) {
    await terminate(1, 'SIGTERM', error);
  }

  return completion;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  process.exitCode = await runDaemonDevSupervisor();
}
