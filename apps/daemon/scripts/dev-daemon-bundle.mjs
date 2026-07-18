import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { context as createEsbuildContext } from 'esbuild';

const daemonRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(daemonRoot, '../..');
const workspacePackagePattern =
  /^@geulbat\/(agent-loop|protocol|shared-utils|tool-library)(\/.*)?$/;
const bundledWorkspacePackages = Object.freeze({
  'agent-loop': 'packages/agent-loop/src',
  protocol: 'packages/protocol/src',
  'shared-utils': 'packages/shared-utils/src',
  'tool-library': 'packages/tool-library/src',
});

export function getDaemonDevWatchRoots(root = repoRoot) {
  return [
    join(root, 'apps/daemon/src'),
    ...Object.values(bundledWorkspacePackages).map((path) => join(root, path)),
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
        return {
          path: join(root, packageSourceRoot, `${moduleName}.ts`),
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

function createPreserveSourceModuleUrlPlugin(sourceRoots) {
  return {
    name: 'geulbat-preserve-source-module-url',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (!isWithinSourceRoot(sourceRoots, args.path)) {
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
  createContext = createEsbuildContext,
  reportInfo = () => {},
} = {}) {
  const entryPath = join(appRoot, 'dist-dev/index.mjs');
  const sourceRoots = getDaemonDevWatchRoots(root);
  await mkdir(dirname(entryPath), { recursive: true });

  const buildContext = await createContext({
    absWorkingDir: root,
    entryPoints: [join(appRoot, 'src/index.ts')],
    bundle: true,
    external: ['@vscode/ripgrep', 'esbuild'],
    format: 'esm',
    outfile: entryPath,
    platform: 'node',
    plugins: [
      createWorkspaceSourcePlugin(root),
      createPreserveSourceModuleUrlPlugin(sourceRoots),
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
