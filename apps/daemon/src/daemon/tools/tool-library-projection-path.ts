import { isAbsolute, join } from 'node:path';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';

export {
  buildToolLibraryProjectionModuleImportSpecifier,
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
} from '@geulbat/tool-library/projection-modules';

export const TOOL_LIBRARY_PROJECTION_PIN_FILE = 'projection-pin.json';

/**
 * 공유 콘텐츠 디렉터리 이름. projection 콘텐츠는 sdkProjectionHash로 주소가 정해진
 * 불변 산출물이라 thread 소유가 아니다. thread가 소유하는 것은 pin 하나뿐이므로
 * 같은 digest를 여러 thread가 가리키면 콘텐츠는 한 벌만 둔다.
 *
 * `thread-` 접두 디렉터리와 이름 공간이 겹치지 않으므로 같은 루트에 나란히 둔다.
 */
export function toolLibraryProjectionsRootPath(stateRoot: string): string {
  return joinWorkspaceGeulbatPath(stateRoot, 'tool-library', 'projections');
}

const TOOL_LIBRARY_PROJECTION_CONTENT_DIRECTORY = 'content';

export function toolLibraryProjectionContentRootPath(
  projectionsRootPath: string,
): string {
  return join(projectionsRootPath, TOOL_LIBRARY_PROJECTION_CONTENT_DIRECTORY);
}

export function isThreadProjectionDirectoryName(value: string): boolean {
  return /^thread-[0-9a-f]{16}$/u.test(value);
}

export function threadProjectionDirectoryName(threadId: string): string {
  return `thread-${sha256StableJson({ threadId }).slice(0, 16)}`;
}

export function resolveToolLibraryProjectionFilePath(
  rootPath: string,
  relativePath: string,
): string {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    throw new Error(
      `Invalid tool library projection file path: ${relativePath}`,
    );
  }

  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(
      `Invalid tool library projection file path: ${relativePath}`,
    );
  }

  return join(rootPath, ...segments);
}
