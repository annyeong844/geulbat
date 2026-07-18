import { isBoolean, isRecord, isString } from './runtime-utils.js';

export const PLUGIN_SKILL_LOGICAL_ROOT = 'geulbat-skill' as const;

const PLUGIN_CAPABILITY_KINDS = [
  'skills',
  'mcpServers',
  'apps',
  'hooks',
] as const;

const PLUGIN_CAPABILITY_SUPPORT_STATUSES = [
  'supported',
  'partially-supported',
  'not-yet-supported',
  'unsupported',
] as const;

const PLUGIN_SKILL_RUNTIME_STATUSES = [
  'available',
  'unavailable-tool-dependencies',
] as const;

const PLUGIN_MARKETPLACE_ENTRY_SOURCE_KINDS = [
  'local',
  'git',
  'npm',
  'unknown',
] as const;

const PLUGIN_MARKETPLACE_ENTRY_STATUSES = [
  'installable',
  'not-available',
  'unsupported-source',
  'invalid-package',
] as const;

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number];

type PluginCapabilitySupportStatus =
  (typeof PLUGIN_CAPABILITY_SUPPORT_STATUSES)[number];

type PluginSkillRuntimeStatus = (typeof PLUGIN_SKILL_RUNTIME_STATUSES)[number];

export type PluginMarketplaceEntrySourceKind =
  (typeof PLUGIN_MARKETPLACE_ENTRY_SOURCE_KINDS)[number];

export type PluginMarketplaceEntryStatus =
  (typeof PLUGIN_MARKETPLACE_ENTRY_STATUSES)[number];

type PluginMarketplaceSourceRole = 'official' | 'custom';

export interface PluginCapabilityView {
  kind: PluginCapabilityKind;
  supportStatus: PluginCapabilitySupportStatus;
  itemCount: number;
}

export interface PluginMarketplaceInstallationSourceView {
  marketplaceId: string;
  marketplaceName: string;
  marketplaceDisplayName: string;
  entryId: string;
  resolvedRevision: string;
}

export interface InstalledPluginView {
  installationId: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  enabled: boolean;
  contentDigest: string;
  sourceKind: 'local-directory' | 'marketplace';
  marketplaceSource?: PluginMarketplaceInstallationSourceView;
  installedAt: string;
  updatedAt: string;
  capabilities: PluginCapabilityView[];
}

export interface PluginListResponse {
  plugins: InstalledPluginView[];
}

export interface PluginMarketplaceSourceView {
  marketplaceId: string;
  name: string;
  displayName: string;
  sourceRole: PluginMarketplaceSourceRole;
  sourceKind: 'git';
  sourceUrl: string;
  requestedRef: string | null;
  resolvedRevision: string;
  addedAt: string;
  refreshedAt: string;
}

export interface PluginMarketplaceEntryView {
  entryId: string;
  marketplaceId: string;
  marketplaceName: string;
  marketplaceDisplayName: string;
  name: string;
  displayName: string;
  version: string | null;
  description: string;
  iconAvailable: boolean;
  category: string;
  sourceKind: PluginMarketplaceEntrySourceKind;
  status: PluginMarketplaceEntryStatus;
  installationPolicy: string;
  authenticationPolicy: string;
  contentDigest: string | null;
  resolvedRevision: string;
  installedInstallationId: string | null;
  capabilities: PluginCapabilityView[];
}

export interface PluginMarketplaceDiagnosticView {
  marketplaceId: string;
  entryName: string | null;
  code:
    | 'invalid-marketplace'
    | 'invalid-entry'
    | 'invalid-package'
    | 'unsupported-source';
  message: string;
}

export interface PluginMarketplaceListResponse {
  sources: PluginMarketplaceSourceView[];
  entries: PluginMarketplaceEntryView[];
  diagnostics: PluginMarketplaceDiagnosticView[];
}

export interface PluginSkillView {
  skillRef: string;
  name: string;
  description: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  runtimeStatus: PluginSkillRuntimeStatus;
  pluginInstallationId: string;
  pluginName: string;
  pluginDisplayName: string;
  pluginVersion: string;
}

interface PluginSkillDiagnosticView {
  pluginInstallationId: string;
  pluginName: string;
  code: 'managed-package-invalid';
  message: string;
}

export interface PluginSkillListResponse {
  skills: PluginSkillView[];
  diagnostics: PluginSkillDiagnosticView[];
}

export interface PluginInstallRequest {
  root: 'computer';
  path: string;
}

export interface PluginMarketplaceAddRequest {
  sourceKind: 'git';
  url: string;
  ref?: string;
}

export interface PluginMarketplaceInstallRequest {
  marketplaceId: string;
  entryId: string;
  expectedContentDigest: string;
}

export interface PluginMarketplaceMutationResponse {
  marketplace: PluginMarketplaceSourceView;
}

export interface PluginMarketplaceDeleteResponse {
  removedMarketplaceId: string;
}

interface PluginEnabledRequest {
  enabled: boolean;
}

export interface PluginMutationResponse {
  plugin: InstalledPluginView;
}

export interface PluginDeleteResponse {
  removedInstallationId: string;
}

export function isPluginInstallRequest(
  value: unknown,
): value is PluginInstallRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['root', 'path']) &&
    value.root === 'computer' &&
    isPortableRelativePath(value.path)
  );
}

export function isPluginMarketplaceAddRequest(
  value: unknown,
): value is PluginMarketplaceAddRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sourceKind', 'url', 'ref']) &&
    value.sourceKind === 'git' &&
    isSafeHttpsGitUrl(value.url) &&
    (value.ref === undefined || isGitRef(value.ref))
  );
}

export function isPluginMarketplaceInstallRequest(
  value: unknown,
): value is PluginMarketplaceInstallRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['marketplaceId', 'entryId', 'expectedContentDigest']) &&
    isNonEmptyString(value.marketplaceId) &&
    isNonEmptyString(value.entryId) &&
    isSha256Digest(value.expectedContentDigest)
  );
}

export function isPluginEnabledRequest(
  value: unknown,
): value is PluginEnabledRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['enabled']) &&
    isBoolean(value.enabled)
  );
}

export function isInstalledPluginView(
  value: unknown,
): value is InstalledPluginView {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'installationId',
      'name',
      'displayName',
      'version',
      'description',
      'enabled',
      'contentDigest',
      'sourceKind',
      'marketplaceSource',
      'installedAt',
      'updatedAt',
      'capabilities',
    ]) ||
    !isNonEmptyString(value.installationId) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.displayName) ||
    !isNonEmptyString(value.version) ||
    !isString(value.description) ||
    !isBoolean(value.enabled) ||
    !isSha256Digest(value.contentDigest) ||
    (value.sourceKind !== 'local-directory' &&
      value.sourceKind !== 'marketplace') ||
    !isIsoTimestamp(value.installedAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !Array.isArray(value.capabilities)
  ) {
    return false;
  }

  if (
    (value.sourceKind === 'local-directory' &&
      value.marketplaceSource !== undefined) ||
    (value.sourceKind === 'marketplace' &&
      !isPluginMarketplaceInstallationSourceView(value.marketplaceSource))
  ) {
    return false;
  }

  const seenKinds = new Set<PluginCapabilityKind>();
  for (const capability of value.capabilities) {
    if (!isPluginCapabilityView(capability) || seenKinds.has(capability.kind)) {
      return false;
    }
    seenKinds.add(capability.kind);
  }
  return true;
}

export function isPluginListResponse(
  value: unknown,
): value is PluginListResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['plugins']) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isInstalledPluginView)
  );
}

export function isPluginMarketplaceListResponse(
  value: unknown,
): value is PluginMarketplaceListResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sources', 'entries', 'diagnostics']) &&
    Array.isArray(value.sources) &&
    value.sources.every(isPluginMarketplaceSourceView) &&
    Array.isArray(value.entries) &&
    value.entries.every(isPluginMarketplaceEntryView) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isPluginMarketplaceDiagnosticView)
  );
}

export function isPluginMarketplaceMutationResponse(
  value: unknown,
): value is PluginMarketplaceMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['marketplace']) &&
    isPluginMarketplaceSourceView(value.marketplace)
  );
}

export function isPluginMarketplaceDeleteResponse(
  value: unknown,
): value is PluginMarketplaceDeleteResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['removedMarketplaceId']) &&
    isNonEmptyString(value.removedMarketplaceId)
  );
}

export function isPluginSkillListResponse(
  value: unknown,
): value is PluginSkillListResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['skills', 'diagnostics']) &&
    Array.isArray(value.skills) &&
    value.skills.every(isPluginSkillView) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isPluginSkillDiagnosticView)
  );
}

export function isPluginSkillLogicalPath(value: string): boolean {
  return (
    value === PLUGIN_SKILL_LOGICAL_ROOT ||
    value.startsWith(`${PLUGIN_SKILL_LOGICAL_ROOT}/`)
  );
}

export function isPluginMutationResponse(
  value: unknown,
): value is PluginMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['plugin']) &&
    isInstalledPluginView(value.plugin)
  );
}

export function isPluginDeleteResponse(
  value: unknown,
): value is PluginDeleteResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['removedInstallationId']) &&
    isNonEmptyString(value.removedInstallationId)
  );
}

function isPluginCapabilityView(value: unknown): value is PluginCapabilityView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'supportStatus', 'itemCount']) &&
    isPluginCapabilityKind(value.kind) &&
    isPluginCapabilitySupportStatus(value.supportStatus) &&
    typeof value.itemCount === 'number' &&
    Number.isSafeInteger(value.itemCount) &&
    value.itemCount > 0
  );
}

function isPluginMarketplaceInstallationSourceView(
  value: unknown,
): value is PluginMarketplaceInstallationSourceView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'marketplaceId',
      'marketplaceName',
      'marketplaceDisplayName',
      'entryId',
      'resolvedRevision',
    ]) &&
    isNonEmptyString(value.marketplaceId) &&
    isNonEmptyString(value.marketplaceName) &&
    isNonEmptyString(value.marketplaceDisplayName) &&
    isNonEmptyString(value.entryId) &&
    isGitRevision(value.resolvedRevision)
  );
}

function isPluginMarketplaceSourceView(
  value: unknown,
): value is PluginMarketplaceSourceView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'marketplaceId',
      'name',
      'displayName',
      'sourceRole',
      'sourceKind',
      'sourceUrl',
      'requestedRef',
      'resolvedRevision',
      'addedAt',
      'refreshedAt',
    ]) &&
    isNonEmptyString(value.marketplaceId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.displayName) &&
    (value.sourceRole === 'official' || value.sourceRole === 'custom') &&
    value.sourceKind === 'git' &&
    isSafeHttpsGitUrl(value.sourceUrl) &&
    (value.requestedRef === null || isGitRef(value.requestedRef)) &&
    isGitRevision(value.resolvedRevision) &&
    isIsoTimestamp(value.addedAt) &&
    isIsoTimestamp(value.refreshedAt)
  );
}

function isPluginMarketplaceEntryView(
  value: unknown,
): value is PluginMarketplaceEntryView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'entryId',
      'marketplaceId',
      'marketplaceName',
      'marketplaceDisplayName',
      'name',
      'displayName',
      'version',
      'description',
      'iconAvailable',
      'category',
      'sourceKind',
      'status',
      'installationPolicy',
      'authenticationPolicy',
      'contentDigest',
      'resolvedRevision',
      'installedInstallationId',
      'capabilities',
    ]) &&
    isNonEmptyString(value.entryId) &&
    isNonEmptyString(value.marketplaceId) &&
    isNonEmptyString(value.marketplaceName) &&
    isNonEmptyString(value.marketplaceDisplayName) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.displayName) &&
    (value.version === null || isNonEmptyString(value.version)) &&
    isString(value.description) &&
    isBoolean(value.iconAvailable) &&
    isNonEmptyString(value.category) &&
    isPluginMarketplaceEntrySourceKind(value.sourceKind) &&
    isPluginMarketplaceEntryStatus(value.status) &&
    isNonEmptyString(value.installationPolicy) &&
    isNonEmptyString(value.authenticationPolicy) &&
    (value.contentDigest === null || isSha256Digest(value.contentDigest)) &&
    isGitRevision(value.resolvedRevision) &&
    (value.installedInstallationId === null ||
      isNonEmptyString(value.installedInstallationId)) &&
    Array.isArray(value.capabilities) &&
    hasUniquePluginCapabilities(value.capabilities)
  );
}

function isPluginMarketplaceDiagnosticView(
  value: unknown,
): value is PluginMarketplaceDiagnosticView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['marketplaceId', 'entryName', 'code', 'message']) &&
    isNonEmptyString(value.marketplaceId) &&
    (value.entryName === null || isNonEmptyString(value.entryName)) &&
    (value.code === 'invalid-marketplace' ||
      value.code === 'invalid-entry' ||
      value.code === 'invalid-package' ||
      value.code === 'unsupported-source') &&
    isNonEmptyString(value.message)
  );
}

function hasUniquePluginCapabilities(value: unknown[]): boolean {
  const seenKinds = new Set<PluginCapabilityKind>();
  for (const capability of value) {
    if (!isPluginCapabilityView(capability) || seenKinds.has(capability.kind)) {
      return false;
    }
    seenKinds.add(capability.kind);
  }
  return true;
}

function isPluginSkillView(value: unknown): value is PluginSkillView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'skillRef',
      'name',
      'description',
      'enabled',
      'allowImplicitInvocation',
      'runtimeStatus',
      'pluginInstallationId',
      'pluginName',
      'pluginDisplayName',
      'pluginVersion',
    ]) &&
    isNonEmptyString(value.name) &&
    isString(value.description) &&
    isBoolean(value.enabled) &&
    isBoolean(value.allowImplicitInvocation) &&
    isPluginSkillRuntimeStatus(value.runtimeStatus) &&
    isNonEmptyString(value.pluginInstallationId) &&
    isPluginSkillRef(value.skillRef, value.pluginInstallationId) &&
    isNonEmptyString(value.pluginName) &&
    isNonEmptyString(value.pluginDisplayName) &&
    isNonEmptyString(value.pluginVersion)
  );
}

function isPluginSkillDiagnosticView(
  value: unknown,
): value is PluginSkillDiagnosticView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'pluginInstallationId',
      'pluginName',
      'code',
      'message',
    ]) &&
    isNonEmptyString(value.pluginInstallationId) &&
    isNonEmptyString(value.pluginName) &&
    value.code === 'managed-package-invalid' &&
    isNonEmptyString(value.message)
  );
}

function isPluginCapabilityKind(value: unknown): value is PluginCapabilityKind {
  return (
    isString(value) &&
    (PLUGIN_CAPABILITY_KINDS as readonly string[]).includes(value)
  );
}

function isPluginCapabilitySupportStatus(
  value: unknown,
): value is PluginCapabilitySupportStatus {
  return (
    isString(value) &&
    (PLUGIN_CAPABILITY_SUPPORT_STATUSES as readonly string[]).includes(value)
  );
}

function isPluginSkillRuntimeStatus(
  value: unknown,
): value is PluginSkillRuntimeStatus {
  return (
    isString(value) &&
    (PLUGIN_SKILL_RUNTIME_STATUSES as readonly string[]).includes(value)
  );
}

function isPluginMarketplaceEntrySourceKind(
  value: unknown,
): value is PluginMarketplaceEntrySourceKind {
  return (
    isString(value) &&
    (PLUGIN_MARKETPLACE_ENTRY_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

function isPluginMarketplaceEntryStatus(
  value: unknown,
): value is PluginMarketplaceEntryStatus {
  return (
    isString(value) &&
    (PLUGIN_MARKETPLACE_ENTRY_STATUSES as readonly string[]).includes(value)
  );
}

function isSafeHttpsGitUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isGitRef(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !value.startsWith('-') &&
    !/[\u0000-\u0020\u007f]/u.test(value) &&
    !/[~^:?*[\]\\]/u.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    !value.endsWith('/')
  );
}

function isGitRevision(value: unknown): value is string {
  return isString(value) && /^git:[a-f0-9]{40,64}$/u.test(value);
}

function isPluginSkillRef(
  value: unknown,
  installationId: string,
): value is string {
  if (!isString(value)) {
    return false;
  }
  const [logicalRoot, refInstallationId, digest, ...unexpectedSegments] =
    value.split('/');
  return (
    unexpectedSegments.length === 0 &&
    logicalRoot === PLUGIN_SKILL_LOGICAL_ROOT &&
    refInstallationId === installationId &&
    /^[a-f0-9]{64}$/u.test(digest ?? '')
  );
}

function isPortableRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\0')) {
    return false;
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    return false;
  }
  return normalized.split('/').every((segment) => segment !== '..');
}

function isSha256Digest(value: unknown): value is string {
  return isString(value) && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    isString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
