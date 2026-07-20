import { isAbsolute, join } from 'node:path';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';

export {
  buildToolLibraryProjectionModuleImportSpecifier,
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
} from '@geulbat/tool-library/projection-modules';

export const TOOL_LIBRARY_PROJECTION_PIN_FILE = 'projection-pin.json';

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
