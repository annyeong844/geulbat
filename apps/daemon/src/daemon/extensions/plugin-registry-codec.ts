import type { InstalledPluginView } from '@geulbat/protocol/plugins';
import { isInstalledPluginView } from '@geulbat/protocol/plugins';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import { constants, lstat, open } from 'node:fs/promises';

import { getErrorCode } from '../utils/error.js';
import { assertManagedRegularFile } from './plugin-managed-directory.js';
import { PluginStoreError } from './plugin-store-contract.js';

// plugin registry.json 코덱 — 온디스크 레지스트리의 스키마 버전, 레코드
// shape, 검증 규칙(중복/유효 id, 레거시 마이그레이션 매핑)과 parse/serialize
// 짝을 이 파일이 단독 소유한다. 이전에는 이 지식이 plugin-store.ts 안의 상수
// 블록·타입 블록·리더 함수 세 곳에 흩어져 있었다. 파일 I/O 중 guarded
// write(managed-root 확인+원자적 쓰기)는 store가 갖고, 여기서는 안전한
// 읽기(O_NOFOLLOW·inode 재확인)와 순수 직렬화만 다룬다.

export const REGISTRY_SCHEMA_VERSION = 4 as const;
const LEGACY_REGISTRY_SCHEMA_VERSION = 1 as const;
const SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION = 2 as const;
const MCP_RUNTIME_REGISTRY_SCHEMA_VERSION = 3 as const;
export const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const CONTENT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface PersistedPluginRegistry {
  schemaVersion:
    | typeof LEGACY_REGISTRY_SCHEMA_VERSION
    | typeof SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION
    | typeof MCP_RUNTIME_REGISTRY_SCHEMA_VERSION
    | typeof REGISTRY_SCHEMA_VERSION;
  plugins: PersistedPluginRecord[];
}

interface PersistedPluginRecord {
  view: InstalledPluginView;
  packageObjectId: string;
}

/** 현재 스키마 버전의 레지스트리 문서를 만든다. object identity가 빠진
 * 플러그인은 corrupt_registry로 즉시 실패한다(호출자 try 밖에서 전파). */
export function serializePluginRegistry(
  plugins: InstalledPluginView[],
  objectIds: ReadonlyMap<string, string>,
): PersistedPluginRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    plugins: plugins.map((plugin) => {
      const packageObjectId = objectIds.get(plugin.installationId);
      if (!packageObjectId) {
        throw new PluginStoreError(
          'corrupt_registry',
          'plugin package object identity is missing',
        );
      }
      return { view: plugin, packageObjectId };
    }),
  };
}

export async function readPersistedRegistry(
  registryPath: string,
): Promise<PersistedPluginRegistry | undefined> {
  let expectedStats: Awaited<ReturnType<typeof lstat>>;
  try {
    expectedStats = await lstat(registryPath);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  assertManagedRegularFile(expectedStats, 'plugin registry');

  const registryFile = await open(
    registryPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let raw: string;
  try {
    const openedStats = await registryFile.stat();
    assertManagedRegularFile(openedStats, 'plugin registry');
    if (
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino
    ) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin registry changed while it was being opened',
      );
    }
    raw = await registryFile.readFile('utf8');
  } finally {
    await registryFile.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry is not valid JSON',
    );
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ['schemaVersion', 'plugins']) ||
    (parsed['schemaVersion'] !== LEGACY_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== MCP_RUNTIME_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== REGISTRY_SCHEMA_VERSION) ||
    !Array.isArray(parsed['plugins'])
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry has an invalid shape',
    );
  }
  const plugins: PersistedPluginRecord[] =
    parsed['schemaVersion'] === REGISTRY_SCHEMA_VERSION
      ? parsed['plugins'].every(isPersistedPluginRecord)
        ? parsed['plugins']
        : []
      : parsed['plugins'].every(isInstalledPluginView)
        ? parsed['plugins'].map((view) => ({
            view,
            packageObjectId: view.installationId,
          }))
        : [];
  if (plugins.length !== parsed['plugins'].length) {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry has an invalid shape',
    );
  }
  const seenIds = new Set<string>();
  const seenPackageObjectIds = new Set<string>();
  for (const plugin of plugins) {
    if (
      !INSTALLATION_ID_PATTERN.test(plugin.view.installationId) ||
      seenIds.has(plugin.view.installationId) ||
      !INSTALLATION_ID_PATTERN.test(plugin.packageObjectId) ||
      seenPackageObjectIds.has(plugin.packageObjectId)
    ) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin registry contains an invalid or duplicate object identity',
      );
    }
    seenIds.add(plugin.view.installationId);
    seenPackageObjectIds.add(plugin.packageObjectId);
  }
  return {
    schemaVersion: parsed['schemaVersion'],
    plugins,
  };
}

function isPersistedPluginRecord(
  value: unknown,
): value is PersistedPluginRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['view', 'packageObjectId']) &&
    isInstalledPluginView(value['view']) &&
    typeof value['packageObjectId'] === 'string'
  );
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
