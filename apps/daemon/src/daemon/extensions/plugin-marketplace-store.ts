import type {
  InstalledPluginView,
  PluginMarketplaceAddRequest,
  PluginMarketplaceInstallRequest,
  PluginMarketplaceListResponse,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';
import {
  isPluginMarketplaceAddRequest,
  isPluginMarketplaceInstallRequest,
  isPluginMarketplaceListResponse,
} from '@geulbat/protocol/plugins';
import { isPluginRecord as isRecord } from './plugin-value-guards.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { checkNoSymlinkPathSegments } from '../files/normalize-path.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorCode } from '../utils/error.js';
import { inspectPluginPackage } from './plugin-package-admission.js';
import type { PluginMarketplaceInstallCandidate } from './plugin-store.js';
import {
  PLUGIN_NAME_PATTERN,
  PluginMarketplaceStoreError,
  safeDiagnosticMessage,
  type PluginMarketplaceGitAcquirer,
} from './plugin-marketplace-contract.js';
import { createMarketplaceCatalogStateOwner } from './plugin-marketplace-state.js';
import {
  acquirePluginMarketplaceGitRepository,
  readGitRevision,
} from './plugin-marketplace-git.js';
import { readTextFileNoFollow } from './plugin-marketplace-fs.js';
import {
  inspectMarketplaceRepository,
  type MarketplaceCatalogSnapshot,
} from './plugin-marketplace-catalog.js';

const REGISTRY_SCHEMA_VERSION = 2 as const;
const LEGACY_REGISTRY_SCHEMA_VERSION = 1 as const;
const MARKETPLACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const OFFICIAL_CODEX_MARKETPLACE_SOURCE = {
  sourceKind: 'git',
  url: 'https://github.com/openai/plugins.git',
  ref: 'main',
} as const satisfies PluginMarketplaceAddRequest;
const OFFICIAL_CODEX_MARKETPLACE_NAME = 'openai-curated';
const OFFICIAL_CODEX_MARKETPLACE_DISPLAY_NAME = 'Codex official';

interface PersistedMarketplaceRegistry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  sources: PluginMarketplaceSourceView[];
}

interface LoadedMarketplaceRegistry {
  schemaVersion:
    | typeof LEGACY_REGISTRY_SCHEMA_VERSION
    | typeof REGISTRY_SCHEMA_VERSION;
  sources: PluginMarketplaceSourceView[];
}

interface ResolvedMarketplaceEntryIcon {
  absolutePath: string;
  contentType: string;
}

export interface PluginMarketplaceStore {
  initialize(): Promise<void>;
  list(
    installedPlugins: readonly InstalledPluginView[],
  ): PluginMarketplaceListResponse;
  add(
    request: PluginMarketplaceAddRequest,
  ): Promise<PluginMarketplaceSourceView>;
  ensureOfficialMarketplace(): Promise<PluginMarketplaceSourceView>;
  remove(marketplaceId: string): Promise<void>;
  resolveEntryIcon(
    marketplaceId: string,
    entryId: string,
  ): Promise<ResolvedMarketplaceEntryIcon | null>;
  resolveInstallCandidate(
    request: PluginMarketplaceInstallRequest,
  ): Promise<PluginMarketplaceInstallCandidate>;
}

export function createPluginMarketplaceStore(args: {
  homeStateRoot: string;
  acquireGitRepository?: PluginMarketplaceGitAcquirer;
}): PluginMarketplaceStore {
  const extensionsRoot = join(args.homeStateRoot, 'extensions');
  const marketplacesRoot = join(extensionsRoot, 'marketplaces');
  const sourcesRoot = join(marketplacesRoot, 'sources');
  const stagingRoot = join(marketplacesRoot, '.staging');
  const registryPath = join(marketplacesRoot, 'registry.json');
  const state = createMarketplaceCatalogStateOwner({
    persistSources: (sources) => persist(sources),
  });
  const acquireGitSource =
    args.acquireGitRepository ?? acquirePluginMarketplaceGitRepository;

  async function ensureManagedRoots(): Promise<void> {
    await mkdir(sourcesRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(marketplacesRoot, 'marketplace root');
    await assertRegularDirectory(sourcesRoot, 'marketplace sources root');
    await assertRegularDirectory(stagingRoot, 'marketplace staging root');
  }

  async function persist(
    sources: PluginMarketplaceSourceView[],
  ): Promise<void> {
    const registry: PersistedMarketplaceRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      sources,
    };
    await ensureManagedRoots();
    try {
      await writeTextFileAtomically(
        registryPath,
        `${JSON.stringify(registry, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error: unknown) {
      throw safeStorageError(
        'plugin marketplace registry update failed',
        error,
      );
    }
  }

  async function loadCatalog(
    source: PluginMarketplaceSourceView,
  ): Promise<MarketplaceCatalogSnapshot> {
    const sourceRoot = join(sourcesRoot, source.marketplaceId);
    const repositoryRoot = join(sourceRoot, 'repository');
    await assertRegularDirectory(sourceRoot, 'marketplace source');
    await assertRegularDirectory(repositoryRoot, 'marketplace repository');
    const revision = await readGitRevision(
      repositoryRoot,
      source.marketplaceId,
    );
    if (revision !== source.resolvedRevision) {
      throw new PluginMarketplaceStoreError(
        'corrupt_registry',
        'managed marketplace revision does not match its registry record',
      );
    }
    const snapshot = await inspectMarketplaceRepository({
      marketplaceId: source.marketplaceId,
      repositoryRoot,
      sourceRole: source.sourceRole,
      sourceUrl: source.sourceUrl,
      requestedRef: source.requestedRef,
      resolvedRevision: source.resolvedRevision,
      addedAt: source.addedAt,
      refreshedAt: source.refreshedAt,
    });
    if (
      snapshot.source.name !== source.name ||
      snapshot.source.displayName !== source.displayName
    ) {
      throw new PluginMarketplaceStoreError(
        'corrupt_registry',
        'managed marketplace identity does not match its registry record',
      );
    }
    return snapshot;
  }

  async function addSource(
    request: PluginMarketplaceAddRequest,
    sourceRole: PluginMarketplaceSourceView['sourceRole'],
  ): Promise<PluginMarketplaceSourceView> {
    state.requireInitialized();
    if (!isPluginMarketplaceAddRequest(request)) {
      throw new PluginMarketplaceStoreError(
        'invalid_request',
        'marketplace source must be a credential-free HTTPS Git URL',
      );
    }
    if (sourceRole === 'custom' && isOfficialSourceRequest(request)) {
      throw new PluginMarketplaceStoreError(
        'conflict',
        'the Codex official marketplace is managed by the built-in source',
      );
    }
    if (state.hasGitSource(request.url, request.ref ?? null)) {
      throw new PluginMarketplaceStoreError(
        'conflict',
        'this marketplace Git source is already registered',
      );
    }

    await ensureManagedRoots();
    const marketplaceId = randomUUID();
    const stageSourceRoot = join(stagingRoot, marketplaceId);
    const stageRepositoryRoot = join(stageSourceRoot, 'repository');
    const finalSourceRoot = join(sourcesRoot, marketplaceId);
    let movedToFinal = false;
    try {
      await mkdir(stageSourceRoot, { recursive: false, mode: 0o700 });
      await acquireGitSource({
        repositoryRoot: stageRepositoryRoot,
        url: request.url,
        requestedRef: request.ref ?? null,
        isolatedConfigRoot: join(stageSourceRoot, '.git-runtime'),
      });
      const resolvedRevision = await readGitRevision(
        stageRepositoryRoot,
        marketplaceId,
      );
      const now = new Date().toISOString();
      const staged = await inspectMarketplaceRepository({
        marketplaceId,
        repositoryRoot: stageRepositoryRoot,
        sourceRole,
        sourceUrl: request.url,
        requestedRef: request.ref ?? null,
        resolvedRevision,
        addedAt: now,
        refreshedAt: now,
      });
      if (
        sourceRole === 'official' &&
        (staged.source.name !== OFFICIAL_CODEX_MARKETPLACE_NAME ||
          staged.source.displayName !== OFFICIAL_CODEX_MARKETPLACE_DISPLAY_NAME)
      ) {
        throw new PluginMarketplaceStoreError(
          'invalid_request',
          'the built-in source did not resolve the Codex official marketplace',
        );
      }
      if (state.hasSourceName(staged.source.name)) {
        throw new PluginMarketplaceStoreError(
          'conflict',
          `marketplace name is already registered: ${staged.source.name}`,
        );
      }
      await rm(join(stageSourceRoot, '.git-runtime'), {
        recursive: true,
        force: true,
      });
      await rename(stageSourceRoot, finalSourceRoot);
      movedToFinal = true;
      const finalSnapshot = await inspectMarketplaceRepository({
        marketplaceId,
        repositoryRoot: join(finalSourceRoot, 'repository'),
        sourceRole,
        sourceUrl: request.url,
        requestedRef: request.ref ?? null,
        resolvedRevision,
        addedAt: now,
        refreshedAt: now,
      });
      await state.commitRegistered(finalSnapshot);
      return finalSnapshot.source;
    } catch (error: unknown) {
      await rm(movedToFinal ? finalSourceRoot : stageSourceRoot, {
        recursive: true,
        force: true,
      });
      if (error instanceof PluginMarketplaceStoreError) {
        throw error;
      }
      throw safeStorageError('plugin marketplace registration failed', error);
    }
  }

  return {
    async initialize() {
      await state.serialize(async () => {
        if (state.isInitialized()) {
          return;
        }
        await mkdir(args.homeStateRoot, { recursive: true, mode: 0o700 });
        const registry = await readRegistry(registryPath);
        if (!registry) {
          state.markInitialized();
          return;
        }
        await ensureManagedRoots();
        await reconcileManagedSources({
          sourcesRoot,
          stagingRoot,
          registeredIds: new Set(
            registry.sources.map((source) => source.marketplaceId),
          ),
        });
        for (const source of registry.sources) {
          try {
            state.restoreLoadedSnapshot(await loadCatalog(source));
          } catch (error: unknown) {
            state.restoreLoadedSnapshot({
              source,
              entries: [],
              diagnostics: [
                {
                  marketplaceId: source.marketplaceId,
                  entryName: null,
                  code: 'invalid-marketplace',
                  message: safeDiagnosticMessage(
                    'managed marketplace is unavailable or invalid',
                    error,
                  ),
                },
              ],
              localEntryRoots: new Map(),
              iconAssets: new Map(),
            });
          }
        }
        if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
          await persist(registry.sources);
        }
        state.markInitialized();
      });
    },

    list(installedPlugins) {
      state.requireInitialized();
      const installedByEntry = new Map<string, string>();
      for (const plugin of installedPlugins) {
        if (plugin.sourceKind !== 'marketplace' || !plugin.marketplaceSource) {
          continue;
        }
        installedByEntry.set(
          `${plugin.marketplaceSource.marketplaceId}/${plugin.marketplaceSource.entryId}`,
          plugin.installationId,
        );
      }
      const snapshots = state
        .snapshots()
        .sort((left, right) =>
          left.source.displayName.localeCompare(right.source.displayName),
        );
      return {
        sources: snapshots.map((snapshot) => snapshot.source),
        entries: snapshots.flatMap((snapshot) =>
          snapshot.entries.map((entry) => ({
            ...entry,
            installedInstallationId:
              installedByEntry.get(`${entry.marketplaceId}/${entry.entryId}`) ??
              null,
          })),
        ),
        diagnostics: snapshots.flatMap((snapshot) => snapshot.diagnostics),
      };
    },

    async add(request) {
      return state.serialize(() => addSource(request, 'custom'));
    },

    async ensureOfficialMarketplace() {
      return state.serialize(async () => {
        state.requireInitialized();
        const current = state.findOfficialSource();
        if (current) {
          return current;
        }
        return addSource(OFFICIAL_CODEX_MARKETPLACE_SOURCE, 'official');
      });
    },

    async remove(marketplaceId) {
      await state.serialize(async () => {
        state.requireInitialized();
        if (!MARKETPLACE_ID_PATTERN.test(marketplaceId)) {
          throw new PluginMarketplaceStoreError(
            'invalid_request',
            'marketplace identity is invalid',
          );
        }
        const current = state.getSnapshot(marketplaceId);
        if (!current) {
          throw new PluginMarketplaceStoreError(
            'not_found',
            'marketplace source was not found',
          );
        }
        if (current.source.sourceRole === 'official') {
          throw new PluginMarketplaceStoreError(
            'conflict',
            'the Codex official marketplace is a built-in source',
          );
        }
        await state.commitRemoved(marketplaceId);
        try {
          await rm(join(sourcesRoot, marketplaceId), {
            recursive: true,
            force: true,
          });
        } catch (error: unknown) {
          throw safeStorageError(
            'marketplace registry was removed but managed snapshot cleanup failed',
            error,
          );
        }
      });
    },

    async resolveEntryIcon(marketplaceId, entryId) {
      state.requireInitialized();
      if (
        !MARKETPLACE_ID_PATTERN.test(marketplaceId) ||
        !PLUGIN_NAME_PATTERN.test(entryId)
      ) {
        return null;
      }
      const icon = state.getSnapshot(marketplaceId)?.iconAssets.get(entryId);
      if (!icon) {
        return null;
      }
      try {
        const absolutePath = await checkNoSymlinkPathSegments(
          icon.packageRoot,
          join(icon.packageRoot, ...icon.relativePath.split('/')),
        );
        const stats = await lstat(absolutePath);
        if (!stats.isFile()) {
          throw new Error('marketplace icon is not a regular file');
        }
        return { absolutePath, contentType: icon.contentType };
      } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
          return null;
        }
        throw new PluginMarketplaceStoreError(
          'corrupt_registry',
          'managed marketplace icon is unavailable or invalid',
        );
      }
    },

    async resolveInstallCandidate(request) {
      return state.serialize(async () => {
        state.requireInitialized();
        if (!isPluginMarketplaceInstallRequest(request)) {
          throw new PluginMarketplaceStoreError(
            'invalid_request',
            'marketplace plugin install request is invalid',
          );
        }
        const catalog = state.getSnapshot(request.marketplaceId);
        const entry = catalog?.entries.find(
          (candidate) => candidate.entryId === request.entryId,
        );
        if (!catalog || !entry) {
          throw new PluginMarketplaceStoreError(
            'not_found',
            'marketplace plugin was not found',
          );
        }
        if (
          entry.status !== 'installable' ||
          entry.sourceKind !== 'local' ||
          entry.contentDigest === null
        ) {
          throw new PluginMarketplaceStoreError(
            'invalid_request',
            'marketplace plugin source is not installable by this runtime',
          );
        }
        if (entry.contentDigest !== request.expectedContentDigest) {
          throw new PluginMarketplaceStoreError(
            'conflict',
            'marketplace plugin selection is stale',
          );
        }
        const sourceRoot = catalog.localEntryRoots.get(entry.entryId);
        if (!sourceRoot) {
          throw new PluginMarketplaceStoreError(
            'corrupt_registry',
            'marketplace plugin package root is unavailable',
          );
        }
        const inspected = await inspectPluginPackage(sourceRoot);
        if (
          inspected.manifest.name !== entry.name ||
          inspected.manifest.version !== entry.version ||
          inspected.contentDigest !== entry.contentDigest
        ) {
          throw new PluginMarketplaceStoreError(
            'conflict',
            'marketplace plugin bytes changed after catalog inspection',
          );
        }
        return {
          sourceRoot,
          expectedContentDigest: entry.contentDigest,
          source: {
            marketplaceId: catalog.source.marketplaceId,
            marketplaceName: catalog.source.name,
            marketplaceDisplayName: catalog.source.displayName,
            entryId: entry.entryId,
            resolvedRevision: catalog.source.resolvedRevision,
          },
        };
      });
    },
  };
}

async function readRegistry(
  registryPath: string,
): Promise<LoadedMarketplaceRegistry | undefined> {
  const raw = await readTextFileNoFollow(registryPath, 'marketplace registry');
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'plugin marketplace registry is not valid JSON',
    );
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['schemaVersion', 'sources'])) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'plugin marketplace registry has an invalid shape',
    );
  }
  const schemaVersion = parsed['schemaVersion'];
  if (
    schemaVersion !== LEGACY_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== REGISTRY_SCHEMA_VERSION
  ) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'plugin marketplace registry has an invalid shape',
    );
  }
  const normalizedSources =
    schemaVersion === LEGACY_REGISTRY_SCHEMA_VERSION &&
    Array.isArray(parsed['sources'])
      ? parsed['sources'].map((source: unknown) =>
          isRecord(source)
            ? {
                ...source,
                sourceRole: isLegacyOfficialSource(source)
                  ? 'official'
                  : 'custom',
              }
            : source,
        )
      : parsed['sources'];
  const listCandidate: unknown = {
    sources: normalizedSources,
    entries: [],
    diagnostics: [],
  };
  if (!isPluginMarketplaceListResponse(listCandidate)) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'plugin marketplace registry has an invalid shape',
    );
  }
  const sources = listCandidate.sources;
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  let officialSourceSeen = false;
  for (const source of sources) {
    if (
      !MARKETPLACE_ID_PATTERN.test(source.marketplaceId) ||
      seenIds.has(source.marketplaceId) ||
      seenNames.has(source.name) ||
      (source.sourceRole === 'official' &&
        (officialSourceSeen ||
          !isOfficialSourceRequest({
            sourceKind: 'git',
            url: source.sourceUrl,
            ...(source.requestedRef === null
              ? {}
              : { ref: source.requestedRef }),
          })))
    ) {
      throw new PluginMarketplaceStoreError(
        'corrupt_registry',
        'plugin marketplace registry contains duplicate identities',
      );
    }
    seenIds.add(source.marketplaceId);
    seenNames.add(source.name);
    officialSourceSeen ||= source.sourceRole === 'official';
  }
  return { schemaVersion, sources };
}

function isOfficialSourceRequest(
  request: PluginMarketplaceAddRequest,
): boolean {
  return (
    request.sourceKind === OFFICIAL_CODEX_MARKETPLACE_SOURCE.sourceKind &&
    request.url === OFFICIAL_CODEX_MARKETPLACE_SOURCE.url &&
    request.ref === OFFICIAL_CODEX_MARKETPLACE_SOURCE.ref
  );
}

function isLegacyOfficialSource(source: Record<string, unknown>): boolean {
  return (
    source['sourceKind'] === OFFICIAL_CODEX_MARKETPLACE_SOURCE.sourceKind &&
    source['sourceUrl'] === OFFICIAL_CODEX_MARKETPLACE_SOURCE.url &&
    source['requestedRef'] === OFFICIAL_CODEX_MARKETPLACE_SOURCE.ref
  );
}

async function reconcileManagedSources(args: {
  sourcesRoot: string;
  stagingRoot: string;
  registeredIds: Set<string>;
}): Promise<void> {
  await rm(args.stagingRoot, { recursive: true, force: true });
  await mkdir(args.stagingRoot, { recursive: true, mode: 0o700 });
  const entries = await readdir(args.sourcesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!args.registeredIds.has(entry.name)) {
      await rm(join(args.sourcesRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

async function assertRegularDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      `${label} is not a regular directory`,
    );
  }
}

function safeStorageError(message: string, error: unknown): Error {
  return new PluginMarketplaceStoreError(
    'corrupt_registry',
    safeDiagnosticMessage(message, error),
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
