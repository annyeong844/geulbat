// Plugin marketplace 카탈로그 빌더 — 취득된 저장소에서 marketplace.json을
// 안전하게 읽고(무추종·경로 격리) 엔트리별 패키지를 admission으로 검사해
// 카탈로그 스냅샷(소스 뷰·엔트리·진단·설치 가능 루트·아이콘 자산)을
// 조립한다. store 팩토리 상태에는 의존하지 않는 closure-free 층이다.
import type {
  PluginMarketplaceDiagnosticView,
  PluginMarketplaceEntrySourceKind,
  PluginMarketplaceEntryStatus,
  PluginMarketplaceEntryView,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { checkNoSymlinkPathSegments } from '../files/normalize-path.js';
import { getErrorCode } from '../utils/error.js';
import { inspectPluginPackage } from './plugin-package-admission.js';
import { pluginIconContentType } from './plugin-package-manifest.js';
import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';
import {
  isNonEmptyString,
  PLUGIN_NAME_PATTERN,
  PluginMarketplaceStoreError,
  safeDiagnosticMessage,
} from './plugin-marketplace-contract.js';
import { readBufferFileNoFollow } from './plugin-marketplace-fs.js';

export interface MarketplaceCatalogSnapshot {
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

interface MarketplaceDocument {
  name: string;
  displayName: string;
  plugins: unknown[];
}

export async function inspectMarketplaceRepository(args: {
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
