import type { InstalledPluginView } from '@geulbat/protocol/plugins';

import { PluginStoreError } from './plugin-store-contract.js';

// Plugin 설치 레지스트리 도메인 state owner — marketplace-state와 같은
// 패턴. registrations와 packageObjectIds는 항상 쌍으로 전이하며, registry
// persist가 먼저 성공해야 메모리 상태를 바꾼다는 invariant를 이 owner가
// 단독 소유한다. persist 자체(managed-root 가드 + 원자적 쓰기)는 주입받는다.
interface PluginRegistrationStateOwner {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  isInitialized(): boolean;
  markInitialized(): void;
  requireInitialized(): void;
  plugins(): InstalledPluginView[];
  getPlugin(installationId: string): InstalledPluginView | undefined;
  packageObjectIdFor(plugin: InstalledPluginView): string;
  /** 신규 설치 — 신규 쌍을 포함해 persist가 성공한 뒤에만 반영한다. */
  commitInstalled(
    plugin: InstalledPluginView,
    packageObjectId: string,
  ): Promise<void>;
  /** 기존 설치 뷰 교체(enable/disable 등) — persist 성공 후 반영. */
  commitUpdated(updated: InstalledPluginView): Promise<void>;
  /** 설치 제거 — 남은 목록 persist가 성공한 뒤에만 쌍을 지운다. */
  commitRemoved(installationId: string): Promise<void>;
  /** initialize 로드 경로 전용 — persist 없이 벌크 복원한다. */
  restoreLoaded(
    plugins: readonly InstalledPluginView[],
    objectIds: ReadonlyMap<string, string>,
  ): void;
  /** initialize 실패 시 쌍을 함께 비운다. */
  resetOnInitializationFailure(): void;
}

export function createPluginRegistrationStateOwner(args: {
  persistRegistry(
    plugins: InstalledPluginView[],
    objectIds: ReadonlyMap<string, string>,
  ): Promise<void>;
}): PluginRegistrationStateOwner {
  const registrations = new Map<string, InstalledPluginView>();
  const packageObjectIds = new Map<string, string>();
  let initialized = false;
  let mutationTail: Promise<void> = Promise.resolve();

  return {
    serialize(operation) {
      const result = mutationTail.then(operation, operation);
      mutationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    isInitialized() {
      return initialized;
    },

    markInitialized() {
      initialized = true;
    },

    requireInitialized() {
      if (!initialized) {
        throw new Error('plugin store is not initialized');
      }
    },

    plugins() {
      return [...registrations.values()];
    },

    getPlugin(installationId) {
      return registrations.get(installationId);
    },

    packageObjectIdFor(plugin) {
      const packageObjectId = packageObjectIds.get(plugin.installationId);
      if (!packageObjectId) {
        throw new PluginStoreError(
          'corrupt_registry',
          'plugin package object identity is missing',
        );
      }
      return packageObjectId;
    },

    async commitInstalled(plugin, packageObjectId) {
      const nextObjectIds = new Map(packageObjectIds);
      nextObjectIds.set(plugin.installationId, packageObjectId);
      await args.persistRegistry(
        [...registrations.values(), plugin],
        nextObjectIds,
      );
      packageObjectIds.set(plugin.installationId, packageObjectId);
      registrations.set(plugin.installationId, plugin);
    },

    async commitUpdated(updated) {
      const next = [...registrations.values()].map((plugin) =>
        plugin.installationId === updated.installationId ? updated : plugin,
      );
      await args.persistRegistry(next, packageObjectIds);
      registrations.set(updated.installationId, updated);
    },

    async commitRemoved(installationId) {
      const remaining = [...registrations.values()].filter(
        (plugin) => plugin.installationId !== installationId,
      );
      await args.persistRegistry(remaining, packageObjectIds);
      registrations.delete(installationId);
      packageObjectIds.delete(installationId);
    },

    restoreLoaded(plugins, objectIds) {
      for (const plugin of plugins) {
        registrations.set(plugin.installationId, plugin);
        packageObjectIds.set(
          plugin.installationId,
          objectIds.get(plugin.installationId) ?? plugin.installationId,
        );
      }
    },

    resetOnInitializationFailure() {
      registrations.clear();
      packageObjectIds.clear();
    },
  };
}
