// Plugin marketplace no-follow 안전 읽기 — 심링크 무추종(O_NOFOLLOW)과
// lstat/open 정합(dev·ino) 검증으로 TOCTOU 치환을 차단하는 파일 읽기.
// store의 레지스트리 로딩과 catalog의 marketplace.json 읽기가 공유한다.
import { constants, lstat, open } from 'node:fs/promises';

import { getErrorCode } from '../utils/error.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';

export async function readTextFileNoFollow(
  path: string,
  label: string,
): Promise<string | undefined> {
  const raw = await readBufferFileNoFollow(path, label);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      `${label} is not valid UTF-8`,
    );
  }
}

export async function readBufferFileNoFollow(
  path: string,
  label: string,
): Promise<Buffer | undefined> {
  let expectedStats: Awaited<ReturnType<typeof lstat>>;
  try {
    expectedStats = await lstat(path);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      `${label} is not a regular file`,
    );
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStats = await file.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino
    ) {
      throw new PluginMarketplaceStoreError(
        'corrupt_registry',
        `${label} changed while it was being opened`,
      );
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}
