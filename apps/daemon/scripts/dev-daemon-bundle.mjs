import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { context as createEsbuildContext } from 'esbuild';

const daemonRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(daemonRoot, '../..');
const workspacePackagePattern =
  /^@geulbat\/(agent-loop|artifact-runtime-policy|content-identity|daemon|daemon-lifecycle|protocol|structured-logger|tool-library|xharness)(\/.*)?$/;
const bundledWorkspacePackages = Object.freeze({
  'agent-loop': 'packages/agent-loop/src',
  'artifact-runtime-policy': 'packages/artifact-runtime-policy/src',
  'content-identity': 'packages/content-identity/src',
  daemon: 'apps/daemon/src',
  'daemon-lifecycle': 'packages/daemon-lifecycle/src',
  protocol: 'packages/protocol/src',
  'structured-logger': 'packages/structured-logger/src',
  'tool-library': 'packages/tool-library/src',
  xharness: 'packages/xharness/src',
});
// Public daemon subpaths whose canonical source module does not sit at the
// src/<subpath>.ts convention. Keep in sync with apps/daemon/package.json
// exports so dev bundling and npm distribution resolve the same owner.
const daemonSubpathSourceOverrides = Object.freeze({
  'loop-implementation-admission': 'daemon/agent/loop-implementation-admission',
  'prompt-component-identity': 'daemon/agent/loop-prompt',
  // package export `./instance-admission-lock` → dist/daemon/daemon-instance-admission-lock.js
  'instance-admission-lock': 'daemon/daemon-instance-admission-lock',
  'process-fatal-logging': 'daemon/utils/process-fatal-logging',
});
export function getDaemonDevWatchRoots(root = repoRoot) {
  return [
    ...new Set(
      ['apps/daemon/src', ...Object.values(bundledWorkspacePackages)].map(
        (path) => join(root, path),
      ),
    ),
  ];
}

function createWorkspaceSourcePlugin(root) {
  return {
    name: 'geulbat-workspace-source',
    setup(build) {
      build.onResolve({ filter: workspacePackagePattern }, (args) => {
        const packagePath = args.path.slice('@geulbat/'.length);
        const separatorIndex = packagePath.indexOf('/');
        const packageName =
          separatorIndex < 0
            ? packagePath
            : packagePath.slice(0, separatorIndex);
        const moduleName =
          separatorIndex < 0 ? 'index' : packagePath.slice(separatorIndex + 1);
        const packageSourceRoot = bundledWorkspacePackages[packageName];
        if (packageSourceRoot === undefined) {
          return undefined;
        }
        const sourceModuleName =
          packageName === 'daemon'
            ? (daemonSubpathSourceOverrides[moduleName] ?? moduleName)
            : moduleName;
        return {
          path: join(root, packageSourceRoot, `${sourceModuleName}.ts`),
        };
      });
    },
  };
}

function isWithinSourceRoot(sourceRoots, candidatePath) {
  const normalizedCandidate = resolve(candidatePath);
  return sourceRoots.some((sourceRoot) => {
    const relativePath = relative(resolve(sourceRoot), normalizedCandidate);
    return (
      relativePath === '' ||
      (relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath))
    );
  });
}

function createPreserveSourceModuleUrlPlugin(sourceRoots, bundleEntryPoints) {
  const bundleEntryPointPaths = new Set(
    bundleEntryPoints.map((entryPoint) => resolve(entryPoint)),
  );
  return {
    name: 'geulbat-preserve-source-module-url',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (
          bundleEntryPointPaths.has(resolve(args.path)) ||
          !isWithinSourceRoot(sourceRoots, args.path)
        ) {
          return undefined;
        }
        const source = await readFile(args.path, 'utf8');
        return {
          contents: source.replaceAll(
            'import.meta.url',
            JSON.stringify(pathToFileURL(args.path).href),
          ),
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
        };
      });
    },
  };
}

export async function createDaemonDevBundleBuilder({
  root = repoRoot,
  appRoot = join(root, 'apps/daemon'),
  entryPoint = join(appRoot, 'src/index.ts'),
  // P7.5 §9.3 — command-host 워커는 별도 프로세스 엔트리다. dev 번들도 두
  // 번째 엔트리를 내보내야 worker 모드를 dev에서 켤 수 있다.
  //
  // 경로는 `appRoot`가 아니라 `root` 기준이다: 이 번들러는 제품 앱
  // (apps/geulbat)도 굽고, 그때 appRoot는 그쪽을 가리킨다. 워커 소스는
  // 어느 앱을 굽든 언제나 apps/daemon에 있다.
  commandHostEntryPoint = join(root, 'apps/daemon/src/command-host/main.ts'),
  // PTC callback-host도 데몬과 독립된 command-host system session이다.
  // 제품 앱 번들에서도 daemon source의 전용 엔트리를 함께 내보낸다.
  ptcCallbackHostEntryPoint = join(
    root,
    'apps/daemon/src/daemon/ptc/callback/epoch-callback-host-main.ts',
  ),
  // Provider request sockets must outlive a daemon generation. The dedicated
  // command-host child entry owns one request and its replayable event result.
  responsesRequestHostEntryPoint = join(
    root,
    'apps/daemon/src/daemon/llm/provider/transport/responses-durable-request-host-main.ts',
  ),
  // Public-web reads use the same command-host lifetime boundary. This child
  // owns DNS pinning and the HTTP socket; the daemon only consumes its
  // lossless terminal result.
  publicHttpReadHostEntryPoint = join(
    root,
    'apps/daemon/src/command-host/public-http-read-host-main.ts',
  ),
  // daemon lifecycle worker도 제품 프로세스와 독립된 IPC 프로세스다.
  // 패키지 빌드의 worker.js와 같은 역할을 dev 번들 옆 mjs가 맡는다.
  daemonLifecycleWorkerEntryPoint = join(
    root,
    'packages/daemon-lifecycle/src/worker.ts',
  ),
  sourceRoots = getDaemonDevWatchRoots(root),
  createContext = createEsbuildContext,
  reportInfo = () => {},
} = {}) {
  const outputDirectory = join(appRoot, 'dist-dev');
  const entryPath = join(outputDirectory, 'index.mjs');
  const entryPoints = {
    index: entryPoint,
    'command-host': commandHostEntryPoint,
    'ptc-callback-host': ptcCallbackHostEntryPoint,
    'responses-request-host': responsesRequestHostEntryPoint,
    'public-http-read-host': publicHttpReadHostEntryPoint,
    'daemon-lifecycle-worker': daemonLifecycleWorkerEntryPoint,
  };
  await mkdir(outputDirectory, { recursive: true });

  const buildContext = await createContext({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    external: ['@vscode/ripgrep', 'esbuild'],
    format: 'esm',
    outdir: outputDirectory,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    plugins: [
      createWorkspaceSourcePlugin(root),
      createPreserveSourceModuleUrlPlugin(
        sourceRoots,
        Object.values(entryPoints),
      ),
    ],
    sourcemap: 'linked',
    banner: {
      js: "import { createRequire as __geulbatCreateRequire } from 'node:module'; const require = __geulbatCreateRequire(import.meta.url);",
    },
  });

  return {
    entryPath,
    async rebuild() {
      const startedAt = performance.now();
      await buildContext.rebuild();
      reportInfo(
        `development bundle ready in ${Math.round(performance.now() - startedAt)}ms`,
      );
    },
    async dispose() {
      await buildContext.dispose();
    },
  };
}
