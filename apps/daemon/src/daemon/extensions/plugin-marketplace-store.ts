import type {
  InstalledPluginView,
  PluginMarketplaceAddRequest,
  PluginMarketplaceDiagnosticView,
  PluginMarketplaceEntrySourceKind,
  PluginMarketplaceEntryStatus,
  PluginMarketplaceEntryView,
  PluginMarketplaceInstallRequest,
  PluginMarketplaceListResponse,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';
import {
  isPluginMarketplaceAddRequest,
  isPluginMarketplaceInstallRequest,
  isPluginMarketplaceListResponse,
} from '@geulbat/protocol/plugins';
import { randomUUID } from 'node:crypto';
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { join, posix } from 'node:path';

import { checkNoSymlinkPathSegments } from '../files/normalize-path.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorCode } from '../utils/error.js';
import {
  buildAllowlistedProcessEnv,
  runBoundedProcessCommand,
} from '../utils/process-command.js';
import {
  PluginPackageAdmissionError,
  inspectPluginPackage,
  pluginIconContentType,
} from './plugin-package-admission.js';
import type { PluginMarketplaceInstallCandidate } from './plugin-store.js';

const REGISTRY_SCHEMA_VERSION = 2 as const;
const LEGACY_REGISTRY_SCHEMA_VERSION = 1 as const;
const MARKETPLACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GIT_REVISION_PATTERN = /^git:[a-f0-9]{40,64}$/u;
const NETWORK_ENV_KEYS = [
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
] as const;

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

interface MarketplaceCatalogSnapshot {
  source: PluginMarketplaceSourceView;
  entries: PluginMarketplaceEntryView[];
  diagnostics: PluginMarketplaceDiagnosticView[];
  localEntryRoots: Map<string, string>;
  iconAssets: Map<string, MarketplaceEntryIconAsset>;
}

interface MarketplaceEntryIconAsset {
  packageRoot: string;
  relativePath: string;
  contentType: string;
}

export interface ResolvedMarketplaceEntryIcon {
  absolutePath: string;
  contentType: string;
}

interface MarketplaceDocument {
  name: string;
  displayName: string;
  plugins: unknown[];
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

export type PluginMarketplaceStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'corrupt_registry';

export class PluginMarketplaceStoreError extends Error {
  constructor(
    readonly code: PluginMarketplaceStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginMarketplaceStoreError';
  }
}

export type PluginMarketplaceGitAcquirer = (args: {
  repositoryRoot: string;
  url: string;
  requestedRef: string | null;
  isolatedConfigRoot: string;
}) => Promise<void>;

export function createPluginMarketplaceStore(args: {
  homeStateRoot: string;
  acquireGitRepository?: PluginMarketplaceGitAcquirer;
}): PluginMarketplaceStore {
  const extensionsRoot = join(args.homeStateRoot, 'extensions');
  const marketplacesRoot = join(extensionsRoot, 'marketplaces');
  const sourcesRoot = join(marketplacesRoot, 'sources');
  const stagingRoot = join(marketplacesRoot, '.staging');
  const registryPath = join(marketplacesRoot, 'registry.json');
  const catalogs = new Map<string, MarketplaceCatalogSnapshot>();
  let initialized = false;
  let mutationTail: Promise<void> = Promise.resolve();
  const acquireGitSource =
    args.acquireGitRepository ?? acquirePluginMarketplaceGitRepository;

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function assertInitialized(): void {
    if (!initialized) {
      throw new Error('plugin marketplace store is not initialized');
    }
  }

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
    assertInitialized();
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
    if (
      [...catalogs.values()].some(
        (catalog) =>
          catalog.source.sourceUrl === request.url &&
          catalog.source.requestedRef === (request.ref ?? null),
      )
    ) {
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
      if (
        [...catalogs.values()].some(
          (catalog) => catalog.source.name === staged.source.name,
        )
      ) {
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
      await persist([
        ...[...catalogs.values()].map((catalog) => catalog.source),
        finalSnapshot.source,
      ]);
      catalogs.set(marketplaceId, finalSnapshot);
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
      await serialize(async () => {
        if (initialized) {
          return;
        }
        await mkdir(args.homeStateRoot, { recursive: true, mode: 0o700 });
        const registry = await readRegistry(registryPath);
        if (!registry) {
          initialized = true;
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
            catalogs.set(source.marketplaceId, await loadCatalog(source));
          } catch (error: unknown) {
            catalogs.set(source.marketplaceId, {
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
        initialized = true;
      });
    },

    list(installedPlugins) {
      assertInitialized();
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
      const snapshots = [...catalogs.values()].sort((left, right) =>
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
      return serialize(() => addSource(request, 'custom'));
    },

    async ensureOfficialMarketplace() {
      return serialize(async () => {
        assertInitialized();
        const current = [...catalogs.values()].find(
          (catalog) => catalog.source.sourceRole === 'official',
        );
        if (current) {
          return current.source;
        }
        return addSource(OFFICIAL_CODEX_MARKETPLACE_SOURCE, 'official');
      });
    },

    async remove(marketplaceId) {
      await serialize(async () => {
        assertInitialized();
        if (!MARKETPLACE_ID_PATTERN.test(marketplaceId)) {
          throw new PluginMarketplaceStoreError(
            'invalid_request',
            'marketplace identity is invalid',
          );
        }
        const current = catalogs.get(marketplaceId);
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
        const remaining = [...catalogs.values()]
          .filter((catalog) => catalog.source.marketplaceId !== marketplaceId)
          .map((catalog) => catalog.source);
        await persist(remaining);
        catalogs.delete(marketplaceId);
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
      assertInitialized();
      if (
        !MARKETPLACE_ID_PATTERN.test(marketplaceId) ||
        !PLUGIN_NAME_PATTERN.test(entryId)
      ) {
        return null;
      }
      const icon = catalogs.get(marketplaceId)?.iconAssets.get(entryId);
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
      return serialize(async () => {
        assertInitialized();
        if (!isPluginMarketplaceInstallRequest(request)) {
          throw new PluginMarketplaceStoreError(
            'invalid_request',
            'marketplace plugin install request is invalid',
          );
        }
        const catalog = catalogs.get(request.marketplaceId);
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

async function inspectMarketplaceRepository(args: {
  marketplaceId: string;
  repositoryRoot: string;
  sourceRole: PluginMarketplaceSourceView['sourceRole'];
  sourceUrl: string;
  requestedRef: string | null;
  resolvedRevision: string;
  addedAt: string;
  refreshedAt: string;
}): Promise<MarketplaceCatalogSnapshot> {
  const marketplace = await readMarketplaceDocument(args.repositoryRoot);
  const source: PluginMarketplaceSourceView = {
    marketplaceId: args.marketplaceId,
    name: marketplace.name,
    displayName: marketplace.displayName,
    sourceRole: args.sourceRole,
    sourceKind: 'git',
    sourceUrl: args.sourceUrl,
    requestedRef: args.requestedRef,
    resolvedRevision: args.resolvedRevision,
    addedAt: args.addedAt,
    refreshedAt: args.refreshedAt,
  };
  const entries: PluginMarketplaceEntryView[] = [];
  const diagnostics: PluginMarketplaceDiagnosticView[] = [];
  const localEntryRoots = new Map<string, string>();
  const iconAssets = new Map<string, MarketplaceEntryIconAsset>();
  const seenNames = new Set<string>();

  for (const rawEntry of marketplace.plugins) {
    const entryName = readEntryName(rawEntry);
    if (!entryName || seenNames.has(entryName)) {
      diagnostics.push({
        marketplaceId: args.marketplaceId,
        entryName,
        code: 'invalid-entry',
        message: entryName
          ? 'marketplace contains a duplicate plugin name'
          : 'marketplace contains an entry without a valid plugin name',
      });
      continue;
    }
    seenNames.add(entryName);
    const parsed = readEntryPolicy(rawEntry);
    if (!parsed) {
      diagnostics.push({
        marketplaceId: args.marketplaceId,
        entryName,
        code: 'invalid-entry',
        message: 'marketplace plugin policy or category is invalid',
      });
      continue;
    }
    const sourceKind = readEntrySourceKind(rawEntry);
    const base = {
      entryId: entryName,
      marketplaceId: args.marketplaceId,
      marketplaceName: marketplace.name,
      marketplaceDisplayName: marketplace.displayName,
      name: entryName,
      category: parsed.category,
      sourceKind,
      installationPolicy: parsed.installationPolicy,
      authenticationPolicy: parsed.authenticationPolicy,
      resolvedRevision: args.resolvedRevision,
      installedInstallationId: null,
    } as const;

    if (sourceKind !== 'local') {
      entries.push({
        ...base,
        displayName: entryName,
        version: null,
        description: '',
        iconAvailable: false,
        status: 'unsupported-source',
        contentDigest: null,
        capabilities: [],
      });
      diagnostics.push({
        marketplaceId: args.marketplaceId,
        entryName,
        code: 'unsupported-source',
        message: `${sourceKind} marketplace plugin sources are not active yet`,
      });
      continue;
    }

    const relativePath = readLocalEntryPath(rawEntry);
    if (!relativePath) {
      entries.push({
        ...base,
        displayName: entryName,
        version: null,
        description: '',
        iconAvailable: false,
        status: 'invalid-package',
        contentDigest: null,
        capabilities: [],
      });
      diagnostics.push({
        marketplaceId: args.marketplaceId,
        entryName,
        code: 'invalid-entry',
        message: 'local marketplace plugin path is invalid',
      });
      continue;
    }

    try {
      const requestedRoot = join(
        args.repositoryRoot,
        ...relativePath.split('/').filter(Boolean),
      );
      const sourceRoot = await checkNoSymlinkPathSegments(
        args.repositoryRoot,
        requestedRoot,
      );
      const inspected = await inspectPluginPackage(sourceRoot);
      if (inspected.manifest.name !== entryName) {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          'marketplace entry name does not match its plugin manifest',
        );
      }
      const status: PluginMarketplaceEntryStatus =
        parsed.installationPolicy === 'NOT_AVAILABLE'
          ? 'not-available'
          : 'installable';
      const iconPath = inspected.manifest.iconPath;
      const iconContentType =
        iconPath === null ? null : pluginIconContentType(iconPath);
      entries.push({
        ...base,
        displayName: inspected.manifest.displayName,
        version: inspected.manifest.version,
        description: inspected.manifest.description,
        iconAvailable: iconContentType !== null,
        status,
        contentDigest: inspected.contentDigest,
        capabilities: inspected.capabilities,
      });
      if (iconPath !== null && iconContentType !== null) {
        iconAssets.set(entryName, {
          packageRoot: sourceRoot,
          relativePath: iconPath,
          contentType: iconContentType,
        });
      }
      if (status === 'installable') {
        localEntryRoots.set(entryName, sourceRoot);
      }
    } catch (error: unknown) {
      entries.push({
        ...base,
        displayName: entryName,
        version: null,
        description: '',
        iconAvailable: false,
        status: 'invalid-package',
        contentDigest: null,
        capabilities: [],
      });
      diagnostics.push({
        marketplaceId: args.marketplaceId,
        entryName,
        code: 'invalid-package',
        message: safeDiagnosticMessage(
          'marketplace plugin package is invalid',
          error,
        ),
      });
    }
  }

  entries.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.displayName.localeCompare(right.displayName),
  );
  return { source, entries, diagnostics, localEntryRoots, iconAssets };
}

async function readMarketplaceDocument(
  repositoryRoot: string,
): Promise<MarketplaceDocument> {
  const candidates = [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
  ];
  let raw: Buffer | undefined;
  for (const relativePath of candidates) {
    const requestedPath = join(
      repositoryRoot,
      ...relativePath.split('/').filter(Boolean),
    );
    try {
      await lstat(requestedPath);
      const admittedPath = await checkNoSymlinkPathSegments(
        repositoryRoot,
        requestedPath,
      );
      raw = await readBufferFileNoFollow(admittedPath, 'marketplace catalog');
      break;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  if (!raw) {
    throw new PluginMarketplaceStoreError(
      'invalid_request',
      'Git source does not contain a supported marketplace.json',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new PluginMarketplaceStoreError(
      'invalid_request',
      'marketplace.json is not valid UTF-8 JSON',
    );
  }
  if (!isRecord(parsed) || !isNonEmptyString(parsed['name'])) {
    throw new PluginMarketplaceStoreError(
      'invalid_request',
      'marketplace.json has an invalid identity',
    );
  }
  const interfaceValue = parsed['interface'];
  const displayName =
    isRecord(interfaceValue) && isNonEmptyString(interfaceValue['displayName'])
      ? interfaceValue['displayName']
      : parsed['name'];
  if (!Array.isArray(parsed['plugins'])) {
    throw new PluginMarketplaceStoreError(
      'invalid_request',
      'marketplace.json plugins must be an array',
    );
  }
  return { name: parsed['name'], displayName, plugins: parsed['plugins'] };
}

function readEntryName(value: unknown): string | null {
  return isRecord(value) &&
    isNonEmptyString(value['name']) &&
    PLUGIN_NAME_PATTERN.test(value['name'])
    ? value['name']
    : null;
}

function readEntryPolicy(value: unknown): {
  installationPolicy: string;
  authenticationPolicy: string;
  category: string;
} | null {
  if (!isRecord(value) || !isRecord(value['policy'])) {
    return null;
  }
  const installationPolicy = value['policy']['installation'];
  const authenticationPolicy = value['policy']['authentication'];
  const category = value['category'];
  return isNonEmptyString(installationPolicy) &&
    isNonEmptyString(authenticationPolicy) &&
    isNonEmptyString(category)
    ? { installationPolicy, authenticationPolicy, category }
    : null;
}

function readEntrySourceKind(value: unknown): PluginMarketplaceEntrySourceKind {
  if (!isRecord(value)) {
    return 'unknown';
  }
  const source = value['source'];
  if (typeof source === 'string') {
    return 'local';
  }
  if (!isRecord(source)) {
    return 'unknown';
  }
  if (source['source'] === 'local') {
    return 'local';
  }
  if (source['source'] === 'url' || source['source'] === 'git-subdir') {
    return 'git';
  }
  if (source['source'] === 'npm') {
    return 'npm';
  }
  return 'unknown';
}

function readLocalEntryPath(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = value['source'];
  const rawPath =
    typeof source === 'string'
      ? source
      : isRecord(source) && source['source'] === 'local'
        ? source['path']
        : undefined;
  if (!isNonEmptyString(rawPath) || !rawPath.startsWith('./')) {
    return null;
  }
  const normalized = posix.normalize(rawPath.slice(2));
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('\\')
  ) {
    return null;
  }
  return normalized;
}

export async function acquirePluginMarketplaceGitRepository(args: {
  repositoryRoot: string;
  url: string;
  requestedRef: string | null;
  isolatedConfigRoot: string;
}): Promise<void> {
  await mkdir(args.isolatedConfigRoot, { recursive: true, mode: 0o700 });
  const hooksRoot = join(args.isolatedConfigRoot, 'hooks');
  await mkdir(hooksRoot, { recursive: true, mode: 0o700 });
  const env = {
    ...buildAllowlistedProcessEnv(NETWORK_ENV_KEYS),
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_GLOBAL: join(args.isolatedConfigRoot, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: args.isolatedConfigRoot,
    XDG_CONFIG_HOME: args.isolatedConfigRoot,
  } satisfies NodeJS.ProcessEnv;
  await runGit(
    ['init', '--quiet', args.repositoryRoot],
    env,
    'Git marketplace repository initialization failed',
  );
  await runGit(
    ['-C', args.repositoryRoot, 'config', 'core.hooksPath', hooksRoot],
    env,
    'Git marketplace hook isolation failed',
  );
  await runGit(
    ['-C', args.repositoryRoot, 'remote', 'add', 'origin', args.url],
    env,
    'Git marketplace source registration failed',
  );
  await runGit(
    [
      '-C',
      args.repositoryRoot,
      'fetch',
      '--depth=1',
      '--no-tags',
      'origin',
      args.requestedRef ?? 'HEAD',
    ],
    env,
    'Git marketplace fetch failed',
  );
  await runGit(
    [
      '-C',
      args.repositoryRoot,
      'checkout',
      '--detach',
      '--force',
      'FETCH_HEAD',
    ],
    env,
    'Git marketplace checkout failed',
  );
}

async function readGitRevision(
  repositoryRoot: string,
  marketplaceId: string,
): Promise<string> {
  const env = {
    ...buildAllowlistedProcessEnv([]),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  } satisfies NodeJS.ProcessEnv;
  const result = await runBoundedProcessCommand({
    executable: 'git',
    args: ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
    env,
  });
  if (result.kind !== 'exit' || result.exitCode !== 0) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      `managed marketplace revision is unreadable: ${marketplaceId}`,
    );
  }
  const revision = `git:${result.stdout.trim()}`;
  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new PluginMarketplaceStoreError(
      'corrupt_registry',
      'managed marketplace revision is invalid',
    );
  }
  return revision;
}

async function runGit(
  gitArgs: string[],
  env: NodeJS.ProcessEnv,
  failureMessage: string,
): Promise<void> {
  const result = await runBoundedProcessCommand({
    executable: 'git',
    args: gitArgs,
    env,
  });
  if (result.kind !== 'exit' || result.exitCode !== 0) {
    throw new PluginMarketplaceStoreError('invalid_request', failureMessage);
  }
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

async function readTextFileNoFollow(
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

async function readBufferFileNoFollow(
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

function safeDiagnosticMessage(message: string, error: unknown): string {
  return error instanceof PluginPackageAdmissionError ||
    error instanceof PluginMarketplaceStoreError
    ? `${message}: ${error.message}`
    : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
