import type { OutputFile } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX,
  type ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { writeFileAtomically } from '../utils/atomic-file.js';

const GENERATED_ROOT_ENV = 'GEULBAT_REACT_BUNDLE_INLINE_GENERATED_ROOT';
const DEFAULT_GENERATED_ROOT = path.join(
  os.homedir(),
  '.geulbat',
  'generated',
  'react-bundle-inline',
);

export async function readGeneratedReactBundleInlineManifest(args: {
  cacheKey: string;
  requestOrigin: string;
}): Promise<ReactBundleRuntimeManifest | null> {
  const entryPath = path.join(
    resolveReactBundleInlineGeneratedRoot(),
    args.cacheKey,
    'entry.js',
  );
  if (!(await pathExists(entryPath))) {
    return null;
  }
  return buildGeneratedReactBundleInlineManifest(args);
}

export async function writeGeneratedReactBundleInlineOutput(args: {
  cacheKey: string;
  outputFiles: OutputFile[];
}): Promise<void> {
  const targetDir = path.join(
    resolveReactBundleInlineGeneratedRoot(),
    args.cacheKey,
  );
  await fs.mkdir(targetDir, { recursive: true });

  const outdir = path.resolve('/out');
  for (const outputFile of orderGeneratedOutputFilesForCacheCommit(
    args.outputFiles,
  )) {
    const relativeOutputPath = normalizeOutputFilePath(
      path.relative(outdir, outputFile.path),
    );
    const absoluteOutputPath = resolveGeneratedAssetPath(
      targetDir,
      relativeOutputPath,
    );
    if (!absoluteOutputPath) {
      throw new Error(
        `react bundle inline compile emitted output outside generated cache: ${outputFile.path}`,
      );
    }
    await writeFileAtomically(absoluteOutputPath, outputFile.contents);
  }
}

export async function readGeneratedReactBundleInlineAsset(
  pathname: string,
): Promise<{ contentType: string; body: Buffer } | null> {
  const relativeAssetPath = decodeGeneratedAssetPath(pathname);
  if (!relativeAssetPath) {
    return null;
  }

  const generatedRoot = resolveReactBundleInlineGeneratedRoot();
  const absolutePath = resolveGeneratedAssetPath(
    generatedRoot,
    relativeAssetPath,
  );
  if (!absolutePath) {
    return null;
  }

  try {
    const body = await fs.readFile(absolutePath);
    return {
      contentType: contentTypeForGeneratedAssetPath(relativeAssetPath),
      body,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function buildGeneratedReactBundleInlineManifest(args: {
  cacheKey: string;
  requestOrigin: string;
}): ReactBundleRuntimeManifest {
  const origin = new URL(args.requestOrigin);
  return {
    entryUrl: new URL(
      `${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}${args.cacheKey}/entry.js`,
      origin,
    ).toString(),
  };
}

function resolveReactBundleInlineGeneratedRoot(): string {
  const overridden = process.env[GENERATED_ROOT_ENV]?.trim();
  return overridden ? overridden : DEFAULT_GENERATED_ROOT;
}

export { GENERATED_ROOT_ENV };

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function decodeGeneratedAssetPath(pathname: string): string | null {
  if (!pathname.startsWith(PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX)) {
    return null;
  }

  const rawRelativePath = pathname.slice(
    PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX.length,
  );
  if (!rawRelativePath) {
    return null;
  }

  let decodedRelativePath: string;
  try {
    decodedRelativePath = decodeURIComponent(rawRelativePath);
  } catch {
    return null;
  }

  const segments = decodedRelativePath.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        segment.includes('\\'),
    )
  ) {
    return null;
  }

  return segments.join(path.sep);
}

function resolveGeneratedAssetPath(
  generatedRoot: string,
  relativeAssetPath: string,
): string | null {
  const root = path.resolve(generatedRoot);
  const absolutePath = path.resolve(root, relativeAssetPath);
  const relativePath = path.relative(root, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return absolutePath;
}

function contentTypeForGeneratedAssetPath(relativeAssetPath: string): string {
  const extension = path.extname(relativeAssetPath);
  if (extension === '.css') {
    return 'text/css; charset=utf-8';
  }
  if (extension === '.json' || extension === '.map') {
    return 'application/json; charset=utf-8';
  }
  return 'text/javascript; charset=utf-8';
}

function normalizeOutputFilePath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}

function orderGeneratedOutputFilesForCacheCommit(
  outputFiles: OutputFile[],
): OutputFile[] {
  return [...outputFiles].sort((left, right) => {
    const leftIsEntry = path.basename(left.path) === 'entry.js';
    const rightIsEntry = path.basename(right.path) === 'entry.js';
    if (leftIsEntry === rightIsEntry) {
      return 0;
    }
    return leftIsEntry ? 1 : -1;
  });
}
