import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertDaemonDevPortAvailable,
  createDaemonSourceWatcher,
  runDaemonDevSupervisor,
} from './dev-daemon-supervisor.mjs';
import { createDaemonDevBundleBuilder } from './dev-daemon-bundle.mjs';

const validAuthEnv = {
  GEULBAT_DEV_TOKEN: 'daemon-supervisor-test-token',
  VITE_GEULBAT_DEV_TOKEN: 'daemon-supervisor-test-token',
};

function nextTurn() {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

class FakeWatcher {
  closeCalls = 0;

  async close() {
    this.closeCalls += 1;
  }
}

class FakeChild extends EventEmitter {
  killSignals = [];

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }

  close(code = 0, signal = null) {
    this.emit('close', code, signal);
  }
}

function createFakeSupervisorBoundaries() {
  const watcher = new FakeWatcher();
  const signalSource = new EventEmitter();
  const children = [];
  const bundleBuilder = {
    disposeCalls: 0,
    rebuildCalls: 0,
    entryPath: '/fake/daemon-dev.mjs',
    async rebuild() {
      this.rebuildCalls += 1;
    },
    async dispose() {
      this.disposeCalls += 1;
    },
  };
  let watcherCallbacks;

  return {
    children,
    signalSource,
    watcher,
    bundleBuilder,
    assertPortAvailable: async () => {},
    createBundleBuilder: async () => bundleBuilder,
    createWatcher: async (callbacks) => {
      watcherCallbacks = callbacks;
      return watcher;
    },
    spawnDaemon: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    changeSource: () => watcherCallbacks.onChange(),
    failWatcher: (error) => watcherCallbacks.onError(error),
  };
}

test('daemon development bundle resolves workspace packages from source', async () => {
  const root = await mkdtemp('/tmp/geulbat-daemon-bundle-test-');
  let buildOptions;
  let loadSourceModule;
  let resolveWorkspacePackage;
  const buildContext = {
    rebuildCalls: 0,
    disposeCalls: 0,
    async rebuild() {
      this.rebuildCalls += 1;
    },
    async dispose() {
      this.disposeCalls += 1;
    },
  };
  try {
    const appRoot = join(root, 'apps/daemon');
    const sourceModulePath = join(appRoot, 'src/source-location.ts');
    await mkdir(dirname(sourceModulePath), { recursive: true });
    await writeFile(
      sourceModulePath,
      'export const sourceUrl = import.meta.url;\n',
      'utf8',
    );
    const builder = await createDaemonDevBundleBuilder({
      root,
      appRoot,
      createContext: async (options) => {
        buildOptions = options;
        for (const plugin of options.plugins) {
          plugin.setup({
            onLoad(_options, loadModule) {
              loadSourceModule = loadModule;
            },
            onResolve(_options, resolvePackage) {
              resolveWorkspacePackage = resolvePackage;
            },
          });
        }
        return buildContext;
      },
    });

    assert.equal(builder.entryPath, join(appRoot, 'dist-dev/index.mjs'));
    assert.deepEqual(buildOptions.external, ['@vscode/ripgrep', 'esbuild']);
    assert.deepEqual(
      resolveWorkspacePackage({ path: '@geulbat/protocol/run-channel' }),
      { path: join(root, 'packages/protocol/src/run-channel.ts') },
    );
    const loadedSource = await loadSourceModule({ path: sourceModulePath });
    assert.equal(
      loadedSource.contents,
      `export const sourceUrl = ${JSON.stringify(pathToFileURL(sourceModulePath).href)};\n`,
    );

    await builder.rebuild();
    await builder.dispose();
    assert.equal(buildContext.rebuildCalls, 1);
    assert.equal(buildContext.disposeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon supervisor rejects an occupied port before startup work', async () => {
  const server = createServer();
  await new Promise((resolveListening) =>
    server.listen(0, '127.0.0.1', resolveListening),
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    await assert.rejects(
      assertDaemonDevPortAvailable({
        env: { HOST: '127.0.0.1', PORT: String(address.port) },
      }),
      /already in use/u,
    );
  } finally {
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
});

test('daemon supervisor treats an unexpected child close as terminal', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  const reportedErrors = [];
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: boundaries.createWatcher,
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: (error) => reportedErrors.push(error),
    reportInfo: () => {},
  });
  await nextTurn();

  assert.equal(boundaries.children.length, 1);
  boundaries.children[0].close(7);

  assert.equal(await completion, 7);
  assert.equal(boundaries.watcher.closeCalls, 1);
  assert.equal(boundaries.bundleBuilder.rebuildCalls, 1);
  assert.equal(boundaries.bundleBuilder.disposeCalls, 1);
  assert.equal(boundaries.children.length, 1);
  assert.match(reportedErrors[0].message, /closed unexpectedly with code 7/);
});

test('daemon supervisor coalesces changes while awaiting the old child close', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: boundaries.createWatcher,
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: assert.fail,
    reportInfo: () => {},
  });
  await nextTurn();

  const firstChild = boundaries.children[0];
  boundaries.changeSource();
  boundaries.changeSource();
  await nextTurn();

  assert.deepEqual(firstChild.killSignals, ['SIGTERM']);
  assert.equal(boundaries.children.length, 1);

  firstChild.close();
  await nextTurn();
  assert.equal(boundaries.children.length, 2);

  const replacement = boundaries.children[1];
  boundaries.signalSource.emit('SIGTERM');
  await nextTurn();
  assert.deepEqual(replacement.killSignals, ['SIGTERM']);

  let completed = false;
  void completion.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);

  replacement.close();
  assert.equal(await completion, 143);
  assert.equal(boundaries.watcher.closeCalls, 1);
});

test('daemon supervisor does not kill a child twice when shutdown races a restart', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: boundaries.createWatcher,
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: assert.fail,
    reportInfo: () => {},
  });
  await nextTurn();

  const child = boundaries.children[0];
  boundaries.changeSource();
  await nextTurn();
  assert.deepEqual(child.killSignals, ['SIGTERM']);

  boundaries.signalSource.emit('SIGTERM');
  await nextTurn();
  assert.deepEqual(child.killSignals, ['SIGTERM']);

  child.close();
  assert.equal(await completion, 143);
  assert.equal(boundaries.children.length, 1);
});

test('daemon supervisor shuts down a live child after a watcher failure', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  const watcherError = new Error('polling failed');
  const reportedErrors = [];
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: boundaries.createWatcher,
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: (error) => reportedErrors.push(error),
    reportInfo: () => {},
  });
  await nextTurn();

  boundaries.failWatcher(watcherError);
  await nextTurn();
  assert.deepEqual(boundaries.children[0].killSignals, ['SIGTERM']);

  boundaries.children[0].close();
  assert.equal(await completion, 1);
  assert.deepEqual(reportedErrors, [watcherError]);
});

test('daemon supervisor launches the child before the watcher finishes when no-watch is off', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  let resolveWatcher;
  const watcherGate = new Promise((resolveGate) => {
    resolveWatcher = resolveGate;
  });
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: async (callbacks) => {
      await watcherGate;
      return boundaries.createWatcher(callbacks);
    },
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: assert.fail,
    reportInfo: () => {},
  });
  await nextTurn();

  // Child must be up even while watcher creation is still pending.
  assert.equal(boundaries.children.length, 1);
  resolveWatcher();
  await nextTurn();

  boundaries.signalSource.emit('SIGTERM');
  await nextTurn();
  boundaries.children[0].close();
  assert.equal(await completion, 143);
});

test('daemon supervisor can run without a watcher', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  let createWatcherCalls = 0;
  const completion = runDaemonDevSupervisor({
    baseEnv: {
      ...validAuthEnv,
      GEULBAT_DEV_NO_WATCH: '1',
    },
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: boundaries.createBundleBuilder,
    createWatcher: async (callbacks) => {
      createWatcherCalls += 1;
      return boundaries.createWatcher(callbacks);
    },
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: assert.fail,
    reportInfo: () => {},
  });
  await nextTurn();

  assert.equal(boundaries.children.length, 1);
  assert.equal(createWatcherCalls, 0);
  boundaries.signalSource.emit('SIGTERM');
  await nextTurn();
  boundaries.children[0].close();
  assert.equal(await completion, 143);
});

test('daemon supervisor disposes a bundle builder that resolves during shutdown', async () => {
  const boundaries = createFakeSupervisorBoundaries();
  let resolveBuilder;
  const builderGate = new Promise((resolveGate) => {
    resolveBuilder = resolveGate;
  });
  const completion = runDaemonDevSupervisor({
    baseEnv: validAuthEnv,
    assertPortAvailable: boundaries.assertPortAvailable,
    createBundleBuilder: () => builderGate,
    createWatcher: boundaries.createWatcher,
    spawnDaemon: boundaries.spawnDaemon,
    signalSource: boundaries.signalSource,
    reportError: assert.fail,
    reportInfo: () => {},
  });
  await nextTurn();

  boundaries.signalSource.emit('SIGTERM');
  resolveBuilder(boundaries.bundleBuilder);

  assert.equal(await completion, 143);
  assert.equal(boundaries.children.length, 0);
  assert.equal(boundaries.bundleBuilder.rebuildCalls, 0);
  assert.equal(boundaries.bundleBuilder.disposeCalls, 1);
});

test('daemon source watcher uses polling and filters tests and test support', async () => {
  const sourceRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixture-src',
  );
  const fakeChokidarWatcher = new EventEmitter();
  fakeChokidarWatcher.close = async () => {};
  let watchOptions;
  const changes = [];

  const watcherPromise = createDaemonSourceWatcher({
    sourceRoots: [sourceRoot],
    onChange: (change) => changes.push(change),
    onError: assert.fail,
    loadChokidar: async () => ({
      watch: (_path, options) => {
        watchOptions = options;
        return fakeChokidarWatcher;
      },
    }),
  });
  await nextTurn();
  fakeChokidarWatcher.emit('ready');
  const watcher = await watcherPromise;

  assert.equal(watchOptions.usePolling, true);
  assert.equal(watchOptions.interval, 5_000);
  assert.equal(watchOptions.ignoreInitial, true);
  assert.equal(
    watchOptions.ignored(join(sourceRoot, 'test-support', 'fixture.ts')),
    true,
  );

  fakeChokidarWatcher.emit('all', 'change', join(sourceRoot, 'runtime.ts'));
  fakeChokidarWatcher.emit(
    'all',
    'change',
    join(sourceRoot, 'runtime.test.ts'),
  );
  fakeChokidarWatcher.emit(
    'all',
    'change',
    join(sourceRoot, 'test-support', 'fixture.ts'),
  );
  fakeChokidarWatcher.emit('all', 'change', join(sourceRoot, 'README.md'));

  assert.deepEqual(changes, [
    { eventName: 'change', path: join(sourceRoot, 'runtime.ts') },
  ]);
  await watcher.close();
});

test(
  'daemon source watcher observes a real edit through the polling boundary',
  { timeout: 10_000 },
  async () => {
    const scriptsRoot = dirname(fileURLToPath(import.meta.url));
    const tempRoot = await mkdtemp(join(scriptsRoot, '.dev-supervisor-watch-'));
    const sourceRoot = join(tempRoot, 'src');
    const sourceFile = join(sourceRoot, 'runtime.ts');
    await mkdir(sourceRoot);
    await writeFile(sourceFile, 'export const value = 1;\n', 'utf8');

    let watcher;
    try {
      let resolveObservedChange;
      const observedChange = new Promise((resolveChange) => {
        resolveObservedChange = resolveChange;
      });
      watcher = await createDaemonSourceWatcher({
        sourceRoots: [sourceRoot],
        pollingIntervalMs: 100,
        onChange: resolveObservedChange,
        onError: assert.fail,
      });
      await writeFile(sourceFile, 'export const value = 2;\n', 'utf8');

      assert.deepEqual(await observedChange, {
        eventName: 'change',
        path: sourceFile,
      });
    } finally {
      await watcher?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'daemon supervisor forwards termination to and awaits a real child process',
  { timeout: 10_000 },
  async () => {
    const watcher = new FakeWatcher();
    const signalSource = new EventEmitter();
    let child;
    let childReady;
    const completion = runDaemonDevSupervisor({
      baseEnv: validAuthEnv,
      assertPortAvailable: async () => {},
      createBundleBuilder: async () => ({
        entryPath: '/fake/daemon-dev.mjs',
        async rebuild() {},
        async dispose() {},
      }),
      createWatcher: async () => watcher,
      spawnDaemon: () => {
        child = spawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        childReady = once(child.stdout, 'data');
        return child;
      },
      signalSource,
      reportError: assert.fail,
    });

    try {
      while (childReady === undefined) {
        await nextTurn();
      }
      await childReady;
      signalSource.emit('SIGTERM');
      assert.equal(await completion, 143);
      assert.equal(child.exitCode, 0);
      assert.equal(watcher.closeCalls, 1);
    } finally {
      if (child?.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'close');
      }
    }
  },
);
