import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';

export interface ComputerFileScope {
  root: string;
  browseStartPath?: string;
  browseShortcuts: Array<{ label: string; path: string }>;
}

const BROWSE_SHORTCUT_CANDIDATES: ReadonlyArray<{
  label: string;
  candidates: readonly string[];
}> = [
  {
    label: '바탕 화면',
    candidates: [
      'OneDrive/바탕 화면',
      'OneDrive/Desktop',
      'Desktop',
      '바탕화면',
    ],
  },
  { label: '다운로드', candidates: ['Downloads', '다운로드'] },
  {
    label: '문서',
    candidates: ['OneDrive/문서', 'OneDrive/Documents', 'Documents', '문서'],
  },
  {
    label: '사진',
    candidates: ['OneDrive/사진', 'OneDrive/Pictures', 'Pictures', '사진'],
  },
  { label: '음악', candidates: ['Music', '음악'] },
  { label: '동영상', candidates: ['Videos', '동영상'] },
];

export function createComputerFileScope(args?: {
  root?: string | undefined;
  home?: string | undefined;
  isDirectory?: (path: string) => boolean;
}): ComputerFileScope | undefined {
  if (args?.root === undefined || args.root.trim().length === 0) {
    return undefined;
  }
  const root = resolve(args.root);
  const browseStartPath = args.home?.trim()
    ? normalizeComputerBrowseRelativePath(relative(root, resolve(args.home)))
    : undefined;
  const isDirectory = args.isDirectory ?? defaultIsDirectory;
  const browseShortcuts =
    browseStartPath === undefined
      ? []
      : collectBrowseShortcuts({ root, browseStartPath, isDirectory });
  return {
    root,
    ...(browseStartPath === undefined ? {} : { browseStartPath }),
    browseShortcuts,
  };
}

export function normalizeComputerBrowseRelativePath(
  relativePath: string,
): string | undefined {
  if (
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\')
  ) {
    return undefined;
  }
  return relativePath
    .split(/[\\/]+/u)
    .filter((part) => part.length > 0)
    .join('/');
}

function collectBrowseShortcuts(args: {
  root: string;
  browseStartPath: string;
  isDirectory: (path: string) => boolean;
}): Array<{ label: string; path: string }> {
  const homeAbsolute = join(args.root, args.browseStartPath);
  const pathPrefix =
    args.browseStartPath === '' ? '' : `${args.browseStartPath}/`;
  const found: Array<{ label: string; path: string }> = [];
  for (const group of BROWSE_SHORTCUT_CANDIDATES) {
    const candidate = group.candidates.find((path) =>
      args.isDirectory(join(homeAbsolute, path)),
    );
    if (candidate !== undefined) {
      found.push({ label: group.label, path: `${pathPrefix}${candidate}` });
    }
  }
  return found;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
