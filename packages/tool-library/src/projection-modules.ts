export const TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE = 'manifest.js';
export const TOOL_LIBRARY_PROJECTION_INDEX_MODULE = 'index.js';
export const TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE =
  'search-runtime.js';

export function buildToolLibraryProjectionModuleImportSpecifier(args: {
  importSpecifier: string;
  module: string;
}): string {
  if (args.module === TOOL_LIBRARY_PROJECTION_INDEX_MODULE) {
    return args.importSpecifier;
  }
  const subpath = args.module.endsWith('.js')
    ? args.module.slice(0, -'.js'.length)
    : args.module;
  return `${args.importSpecifier}/${subpath}`;
}
