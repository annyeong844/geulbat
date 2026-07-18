// Plugin store 관리 디렉토리 무결성 가드 — 데몬 소유 루트(extensions/
// plugins/staging)의 identity(canonical path·device·inode·birthtime)를
// 캡처하고, 이후 모든 변이 전에 치환·심링크 스왑이 없었는지 검증한다.
// 상태 없는 파일시스템 정합 계층으로, store 팩토리가 소유한 루트 경로를
// 인자로 받기만 한다.
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getErrorCode } from '../utils/error.js';
import { PluginStoreError, safeErrorMessage } from './plugin-store-contract.js';

export interface ManagedDirectoryIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  birthtimeNs: bigint;
}

export interface ManagedRootIdentities {
  extensions: ManagedDirectoryIdentity;
  plugins: ManagedDirectoryIdentity;
  staging: ManagedDirectoryIdentity;
}

export async function captureManagedRootIdentities(args: {
  extensionsRoot: string;
  pluginsRoot: string;
  stagingRoot: string;
}): Promise<ManagedRootIdentities> {
  return {
    extensions: await captureManagedDirectoryIdentity(
      args.extensionsRoot,
      'extensions root',
    ),
    plugins: await captureManagedDirectoryIdentity(
      args.pluginsRoot,
      'plugins root',
    ),
    staging: await captureManagedDirectoryIdentity(
      args.stagingRoot,
      'plugin staging root',
    ),
  };
}

export async function assertManagedRootIdentities(
  paths: {
    extensionsRoot: string;
    pluginsRoot: string;
    stagingRoot: string;
  },
  expected: ManagedRootIdentities,
): Promise<void> {
  await assertManagedDirectoryIdentity(
    paths.extensionsRoot,
    'extensions root',
    expected.extensions,
  );
  await assertManagedDirectoryIdentity(
    paths.pluginsRoot,
    'plugins root',
    expected.plugins,
  );
  await assertManagedDirectoryIdentity(
    paths.stagingRoot,
    'plugin staging root',
    expected.staging,
  );
}

export async function captureManagedDirectoryIdentity(
  path: string,
  label: string,
): Promise<ManagedDirectoryIdentity> {
  try {
    const stats = await lstat(path, { bigint: true });
    assertManagedDirectory(stats, label);
    return {
      canonicalPath: await realpath(path),
      device: stats.dev,
      inode: stats.ino,
      birthtimeNs: stats.birthtimeNs,
    };
  } catch (error: unknown) {
    if (error instanceof PluginStoreError) {
      throw error;
    }
    throw new PluginStoreError(
      'corrupt_registry',
      safeErrorMessage(`${label} identity could not be verified`, error),
    );
  }
}

export async function assertManagedDirectoryIdentity(
  path: string,
  label: string,
  expected: ManagedDirectoryIdentity,
): Promise<void> {
  const current = await captureManagedDirectoryIdentity(path, label);
  if (
    current.canonicalPath !== expected.canonicalPath ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} changed after plugin store initialization`,
    );
  }
}

export function assertSameManagedDirectoryObject(
  before: ManagedDirectoryIdentity,
  after: ManagedDirectoryIdentity,
  label: string,
): void {
  if (
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.birthtimeNs !== after.birthtimeNs
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} changed while it was moved into place`,
    );
  }
}

export async function reconcileManagedStore(args: {
  extensionsRoot: string;
  pluginsRoot: string;
  stagingRoot: string;
  registeredIds: Set<string>;
}): Promise<void> {
  await ensureManagedDirectory(args.extensionsRoot, 'extensions root');
  await ensureManagedDirectory(args.pluginsRoot, 'plugins root');

  const existingStaging = await lstatIfExists(args.stagingRoot);
  if (existingStaging) {
    assertManagedDirectory(existingStaging, 'plugin staging root');
    await rm(args.stagingRoot, { recursive: true, force: true });
  }
  await ensureManagedDirectory(args.stagingRoot, 'plugin staging root');

  const entries = await readdir(args.pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!args.registeredIds.has(entry.name)) {
      await rm(join(args.pluginsRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

export async function ensureManagedDirectory(
  path: string,
  label: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertManagedDirectory(await lstat(path), label);
}

export async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function assertManagedDirectory(
  stats: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} must be a regular daemon-owned directory`,
    );
  }
}

export function assertManagedRegularFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} must be a regular daemon-owned file`,
    );
  }
}
