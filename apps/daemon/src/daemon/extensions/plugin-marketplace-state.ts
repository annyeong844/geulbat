import type { PluginMarketplaceSourceView } from '@geulbat/protocol/plugins';

import type { MarketplaceCatalogSnapshot } from './plugin-marketplace-catalog.js';

// Marketplace 카탈로그 도메인 state owner — browser-state-runtime 선례를
// 따른다. raw Map은 밖으로 나가지 않고, 상태 전이는 아래 메서드로만
// 일어난다. "registry persist가 먼저 성공해야 메모리 상태를 바꾼다"는
// invariant를 이 owner가 단독 소유하며, persist 자체(파일시스템 정책)는
// 주입받는다.
interface MarketplaceCatalogStateOwner {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  isInitialized(): boolean;
  markInitialized(): void;
  requireInitialized(): void;
  snapshots(): MarketplaceCatalogSnapshot[];
  sources(): PluginMarketplaceSourceView[];
  getSnapshot(marketplaceId: string): MarketplaceCatalogSnapshot | undefined;
  findOfficialSource(): PluginMarketplaceSourceView | undefined;
  hasGitSource(url: string, requestedRef: string | null): boolean;
  hasSourceName(name: string): boolean;
  /** initialize 로드 경로 전용 — persist 없이 스냅샷을 복원한다. */
  restoreLoadedSnapshot(snapshot: MarketplaceCatalogSnapshot): void;
  /** 신규 소스 등록 — persist가 성공한 뒤에만 메모리에 반영한다. */
  commitRegistered(snapshot: MarketplaceCatalogSnapshot): Promise<void>;
  /** 소스 제거 — 남은 목록 persist가 성공한 뒤에만 메모리에서 지운다. */
  commitRemoved(marketplaceId: string): Promise<void>;
}

export function createMarketplaceCatalogStateOwner(args: {
  persistSources(sources: PluginMarketplaceSourceView[]): Promise<void>;
}): MarketplaceCatalogStateOwner {
  const catalogs = new Map<string, MarketplaceCatalogSnapshot>();
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
        throw new Error('plugin marketplace store is not initialized');
      }
    },

    snapshots() {
      return [...catalogs.values()];
    },

    sources() {
      return [...catalogs.values()].map((catalog) => catalog.source);
    },

    getSnapshot(marketplaceId) {
      return catalogs.get(marketplaceId);
    },

    findOfficialSource() {
      for (const catalog of catalogs.values()) {
        if (catalog.source.sourceRole === 'official') {
          return catalog.source;
        }
      }
      return undefined;
    },

    hasGitSource(url, requestedRef) {
      return [...catalogs.values()].some(
        (catalog) =>
          catalog.source.sourceUrl === url &&
          catalog.source.requestedRef === requestedRef,
      );
    },

    hasSourceName(name) {
      return [...catalogs.values()].some(
        (catalog) => catalog.source.name === name,
      );
    },

    restoreLoadedSnapshot(snapshot) {
      catalogs.set(snapshot.source.marketplaceId, snapshot);
    },

    async commitRegistered(snapshot) {
      await args.persistSources([
        ...[...catalogs.values()].map((catalog) => catalog.source),
        snapshot.source,
      ]);
      catalogs.set(snapshot.source.marketplaceId, snapshot);
    },

    async commitRemoved(marketplaceId) {
      const remaining = [...catalogs.values()]
        .filter((catalog) => catalog.source.marketplaceId !== marketplaceId)
        .map((catalog) => catalog.source);
      await args.persistSources(remaining);
      catalogs.delete(marketplaceId);
    },
  };
}
