import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const ARTIFACT_RUNTIME_SOURCE_MODULE_SUFFIX =
  '/src/features/artifacts/runtime-preview/react-bundle/runtime-module-sources.js';

const HASHED_ASSET_DIRECTORY_PREFIX = 'assets/';
const HASHED_ASSET_FILE_NAME_PATTERN = /-[A-Za-z0-9_-]{8,}\.[^.]+$/u;

/**
 * `assets/` 산출물이 content hash를 갖는다는 전제를 빌드 시점에 잠근다.
 *
 * 데몬은 이 전제로 `assets/`를 `immutable`로 서빙한다(재검증 없이 재사용).
 * hash가 사라지면 이름이 고정되므로 브라우저가 새 빌드를 영영 받지 못하고,
 * 그 실패는 캐시가 만료될 때까지 조용하다. 그래서 캐시 정책을 소유한 쪽이
 * 아니라 전제를 만드는 쪽에서 막는다.
 */
function createHashedAssetNamePlugin(): Plugin {
  return {
    name: 'geulbat-hashed-asset-name',
    apply: 'build',
    generateBundle(_options, bundle) {
      const unhashedFileNames = Object.keys(bundle)
        .filter((fileName) =>
          fileName.startsWith(HASHED_ASSET_DIRECTORY_PREFIX),
        )
        .filter((fileName) => !HASHED_ASSET_FILE_NAME_PATTERN.test(fileName));

      if (unhashedFileNames.length > 0) {
        this.error(
          `Emitted ${HASHED_ASSET_DIRECTORY_PREFIX} files must carry a content hash because the daemon serves them as immutable: ${unhashedFileNames.join(', ')}.`,
        );
      }
    },
  };
}

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

/**
 * Vite는 빌드 도구로만 쓴다. 데몬이 산출물을 서빙하므로 dev server도 proxy도
 * 없다: 개발과 제품이 같은 단일 origin 위상을 쓰고, 접속 토큰은 데몬이 진입
 * 문서에 심는다. HMR 대신 `vite build --watch` + 새로고침이다.
 */
export default defineConfig({
  plugins: [
    react(),
    createArtifactRuntimeChunkBoundaryPlugin(),
    createHashedAssetNamePlugin(),
  ],
});
