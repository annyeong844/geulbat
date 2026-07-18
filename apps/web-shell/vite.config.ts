import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_AUTH_COOKIE_NAME = 'geulbat_dev_auth';
const DEV_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 6;
const ARTIFACT_RUNTIME_SOURCE_MODULE_SUFFIX =
  '/src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.js';

function createArtifactRuntimeChunkBoundaryPlugin(): Plugin {
  return {
    name: 'geulbat-artifact-runtime-chunk-boundary',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? [output] : [],
      );
      const chunksByFileName = new Map(
        chunks.map((chunk) => [chunk.fileName, chunk]),
      );
      const artifactRuntimeChunkFileNames = new Set(
        chunks
          .filter((chunk) =>
            Object.keys(chunk.modules).some((moduleId) =>
              moduleId
                .split('?', 1)[0]
                ?.replaceAll('\\', '/')
                .endsWith(ARTIFACT_RUNTIME_SOURCE_MODULE_SUFFIX),
            ),
          )
          .map((chunk) => chunk.fileName),
      );

      if (artifactRuntimeChunkFileNames.size === 0) {
        this.error(
          `The build did not emit ${ARTIFACT_RUNTIME_SOURCE_MODULE_SUFFIX}.`,
        );
      }

      const staticallyReachableChunkFileNames = new Set<string>();
      const visitStaticImports = (fileName: string): void => {
        if (staticallyReachableChunkFileNames.has(fileName)) {
          return;
        }
        const chunk = chunksByFileName.get(fileName);
        if (!chunk) {
          return;
        }
        staticallyReachableChunkFileNames.add(fileName);
        for (const importedFileName of chunk.imports) {
          visitStaticImports(importedFileName);
        }
      };

      for (const entryChunk of chunks.filter((chunk) => chunk.isEntry)) {
        visitStaticImports(entryChunk.fileName);
      }

      const staticallyLoadedArtifactRuntimeChunks = [
        ...artifactRuntimeChunkFileNames,
      ].filter((fileName) => staticallyReachableChunkFileNames.has(fileName));
      if (staticallyLoadedArtifactRuntimeChunks.length > 0) {
        this.error(
          `Artifact runtime sources entered an application entry's static import closure: ${staticallyLoadedArtifactRuntimeChunks.join(', ')}.`,
        );
      }

      const dynamicallyReachableChunkFileNames = new Set<string>();
      const visitAfterDynamicImport = (fileName: string): void => {
        if (dynamicallyReachableChunkFileNames.has(fileName)) {
          return;
        }
        const chunk = chunksByFileName.get(fileName);
        if (!chunk) {
          return;
        }
        dynamicallyReachableChunkFileNames.add(fileName);
        for (const importedFileName of chunk.imports) {
          visitAfterDynamicImport(importedFileName);
        }
        for (const importedFileName of chunk.dynamicImports) {
          visitAfterDynamicImport(importedFileName);
        }
      };

      for (const fileName of staticallyReachableChunkFileNames) {
        const chunk = chunksByFileName.get(fileName);
        if (!chunk) {
          continue;
        }
        for (const dynamicImportFileName of chunk.dynamicImports) {
          visitAfterDynamicImport(dynamicImportFileName);
        }
      }

      if (
        ![...artifactRuntimeChunkFileNames].some((fileName) =>
          dynamicallyReachableChunkFileNames.has(fileName),
        )
      ) {
        this.error(
          'Artifact runtime sources are not reachable from an application entry through a dynamic import.',
        );
      }
    },
  };
}

function createDevAuthCookie(devToken: string): string {
  return [
    `${DEV_AUTH_COOKIE_NAME}=${encodeURIComponent(devToken)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${DEV_AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ');
}

function appendSetCookieHeader(
  existing: string | string[] | number | undefined,
  value: string,
): string[] {
  const next = Array.isArray(existing)
    ? existing.slice()
    : existing === undefined
      ? []
      : [String(existing)];
  if (!next.includes(value)) {
    next.push(value);
  }
  return next;
}

export default defineConfig(({ mode }) => {
  const appRoot = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, appRoot, 'VITE_');
  const devToken =
    process.env.VITE_GEULBAT_DEV_TOKEN ??
    env.VITE_GEULBAT_DEV_TOKEN ??
    process.env.GEULBAT_DEV_TOKEN ??
    '';

  return {
    plugins: [
      react(),
      createArtifactRuntimeChunkBoundaryPlugin(),
      {
        name: 'geulbat-dev-auth-cookie',
        configureServer(server) {
          if (!devToken) {
            return;
          }
          const cookie = createDevAuthCookie(devToken);
          server.middlewares.use((_req, res, next) => {
            res.setHeader(
              'Set-Cookie',
              appendSetCookieHeader(res.getHeader('Set-Cookie'), cookie),
            );
            next();
          });
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3456',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
