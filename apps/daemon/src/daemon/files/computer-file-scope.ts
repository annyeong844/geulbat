import { resolve } from 'node:path';

import { normalizePath } from './normalize-path.js';

export interface ComputerFileScope {
  root: string;
  browseStartPath?: string;
  browseShortcuts: Array<{ label: string; path: string }>;
}

export function createComputerFileScope(args?: {
  root?: string | undefined;
  home?: string | undefined;
  browseLocations?: ReadonlyArray<{ label: string; path: string }>;
}): ComputerFileScope | undefined {
  if (args?.root === undefined || args.root.trim().length === 0) {
    return undefined;
  }
  const root = resolve(args.root);
  const browseStartPath = args.home?.trim()
    ? normalizePath(root, resolve(args.home))
    : undefined;
  const browseShortcuts = deduplicateBrowseShortcuts(
    (args.browseLocations ?? [])
      .filter((location) => location.label.trim().length > 0)
      .map((location) => ({
        label: location.label.trim(),
        path: normalizePath(root, location.path),
      })),
  );
  return {
    root,
    ...(browseStartPath === undefined ? {} : { browseStartPath }),
    browseShortcuts,
  };
}

function deduplicateBrowseShortcuts(
  shortcuts: ReadonlyArray<{ label: string; path: string }>,
): Array<{ label: string; path: string }> {
  const found = new Map<string, { label: string; path: string }>();
  for (const shortcut of shortcuts) {
    if (!found.has(shortcut.path)) {
      found.set(shortcut.path, shortcut);
    }
  }
  return [...found.values()];
}
