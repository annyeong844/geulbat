import {
  isPluginSkillLogicalPath,
  PLUGIN_SKILL_LOGICAL_ROOT,
} from '@geulbat/protocol/plugins';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseDocument } from 'yaml';

const SKILL_DOCUMENT_NAME = 'SKILL.md';

export type PluginSkillRuntimeStatus =
  | 'available'
  | 'unavailable-tool-dependencies';

export interface InspectedPluginSkill {
  entryPath: string;
  directoryPath: string;
  name: string;
  description: string;
  documentDigest: `sha256:${string}`;
  resourcePaths: readonly string[];
  allowImplicitInvocation: boolean;
  runtimeStatus: PluginSkillRuntimeStatus;
}

export interface PluginSkillSource {
  installationId: string;
  name: string;
  displayName: string;
  version: string;
  contentDigest: string;
}

export interface PluginSkillCatalogEntry {
  skillRef: string;
  skillRootRef: string;
  instructionsRef: string;
  name: string;
  description: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  runtimeStatus: PluginSkillRuntimeStatus;
  sourcePlugin: PluginSkillSource;
}

export interface PluginSkillDiagnostic {
  pluginInstallationId: string;
  pluginName: string;
  code: 'managed-package-invalid';
  message: string;
}

export interface PluginSkillInventory {
  skills: PluginSkillCatalogEntry[];
  diagnostics: PluginSkillDiagnostic[];
}

export interface PluginSkillFile {
  logicalPath: string;
  content: string;
  contentDigest: `sha256:${string}`;
  skill: PluginSkillCatalogEntry;
  packageRelativePath: string;
}

export interface PluginSkillDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface PluginSkillDirectory {
  logicalPath: string;
  entries: PluginSkillDirectoryEntry[];
  skill: PluginSkillCatalogEntry;
}

export interface PluginSkillRuntime {
  listPluginSkills(options?: {
    includeDisabled?: boolean;
  }): Promise<PluginSkillInventory>;
  readEnabledSkillFile(logicalPath: string): Promise<PluginSkillFile>;
  listEnabledSkillDirectory(
    logicalPath: string,
    recursive: boolean,
  ): Promise<PluginSkillDirectory>;
}

export function buildPluginSkillDirectoryEntries(args: {
  skillRootRef: string;
  directoryPath: string;
  files: readonly string[];
  recursive: boolean;
}): PluginSkillDirectoryEntry[] | null {
  const directoryPrefix =
    args.directoryPath === '' ? '' : `${args.directoryPath}/`;
  if (
    args.directoryPath !== '' &&
    !args.files.some((file) => file.startsWith(directoryPrefix))
  ) {
    return null;
  }

  const entries = new Map<string, PluginSkillDirectoryEntry['type']>();
  for (const file of args.files) {
    if (!file.startsWith(directoryPrefix)) {
      continue;
    }
    const remainder = file.slice(directoryPrefix.length);
    if (remainder === '') {
      continue;
    }
    const segments = remainder.split('/');
    if (!args.recursive) {
      const childPath = posix.join(args.directoryPath, segments[0]!);
      entries.set(childPath, segments.length === 1 ? 'file' : 'directory');
      continue;
    }
    for (let index = 0; index < segments.length; index += 1) {
      const entryPath = posix.join(
        args.directoryPath,
        ...segments.slice(0, index + 1),
      );
      entries.set(
        entryPath,
        index === segments.length - 1 ? 'file' : 'directory',
      );
    }
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, type]) => ({
      name: posix.basename(entryPath),
      path: `${args.skillRootRef}/${entryPath}`,
      type,
    }));
}

export class PluginSkillDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSkillDocumentError';
  }
}

export function parsePluginSkillDocument(args: {
  entryPath: string;
  content: Buffer;
  openAiMetadata?: Buffer;
  resourcePaths: readonly string[];
}): InspectedPluginSkill {
  const text = decodeUtf8(args.content, args.entryPath);
  const frontmatter = parseFrontmatter(text, args.entryPath);
  const name = readRequiredString(frontmatter, 'name', args.entryPath);
  const description = readRequiredString(
    frontmatter,
    'description',
    args.entryPath,
  );
  // The directory owns containment; authored discovery names never resolve
  // files. Keep cross-client names/descriptions intact even when they differ
  // from strict Agent Skills authoring conventions.
  if (Array.from(name).length > 64) {
    throw new PluginSkillDocumentError(
      `plugin skill name is too long: ${args.entryPath}`,
    );
  }
  validateOptionalFrontmatter(frontmatter, args.entryPath);

  const openAiMetadata =
    args.openAiMetadata === undefined
      ? undefined
      : parseOpenAiMetadata(args.openAiMetadata, args.entryPath);

  return {
    entryPath: args.entryPath,
    directoryPath: posix.dirname(args.entryPath),
    name,
    description,
    documentDigest: digestBuffer(args.content),
    resourcePaths: [...args.resourcePaths].sort((left, right) =>
      left.localeCompare(right),
    ),
    allowImplicitInvocation: openAiMetadata?.allowImplicitInvocation ?? true,
    runtimeStatus:
      openAiMetadata?.hasToolDependencies === true
        ? 'unavailable-tool-dependencies'
        : 'available',
  };
}

export function buildPluginSkillCatalogEntry(args: {
  sourcePlugin: PluginSkillSource;
  skill: InspectedPluginSkill;
  enabled: boolean;
}): PluginSkillCatalogEntry {
  const skillId = createHash('sha256')
    .update(args.skill.entryPath, 'utf8')
    .digest('hex');
  const skillRootRef = `${PLUGIN_SKILL_LOGICAL_ROOT}/${args.sourcePlugin.installationId}/${skillId}`;
  return {
    skillRef: skillRootRef,
    skillRootRef,
    instructionsRef: `${skillRootRef}/${SKILL_DOCUMENT_NAME}`,
    name: args.skill.name,
    description: args.skill.description,
    enabled: args.enabled,
    allowImplicitInvocation: args.skill.allowImplicitInvocation,
    runtimeStatus: args.skill.runtimeStatus,
    sourcePlugin: { ...args.sourcePlugin },
  };
}

export function parsePluginSkillLogicalPath(value: string): {
  installationId: string;
  skillId: string;
  relativePath: string;
} | null {
  if (!isPluginSkillLogicalPath(value) || value.includes('\\')) {
    return null;
  }
  const segments = value.split('/');
  const installationId = segments[1];
  const skillId = segments[2];
  const resourceSegments = segments.slice(3);
  if (
    !installationId ||
    !skillId ||
    !/^[0-9a-f]{64}$/u.test(skillId) ||
    resourceSegments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    return null;
  }
  return {
    installationId,
    skillId,
    relativePath: resourceSegments.join('/'),
  };
}

export function pluginSkillId(entryPath: string): string {
  return createHash('sha256').update(entryPath, 'utf8').digest('hex');
}

export function digestPluginSkillFile(content: Buffer): `sha256:${string}` {
  return digestBuffer(content);
}

function parseFrontmatter(
  text: string,
  displayPath: string,
): Record<string, unknown> {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/u);
  if (lines[0] !== '---') {
    throw new PluginSkillDocumentError(
      `plugin skill is missing YAML frontmatter: ${displayPath}`,
    );
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === '---',
  );
  if (closingIndex < 0) {
    throw new PluginSkillDocumentError(
      `plugin skill YAML frontmatter is not closed: ${displayPath}`,
    );
  }
  return parseYamlRecord(lines.slice(1, closingIndex).join('\n'), displayPath);
}

function parseOpenAiMetadata(
  content: Buffer,
  skillEntryPath: string,
): {
  allowImplicitInvocation?: boolean;
  hasToolDependencies: boolean;
} {
  const displayPath = `${posix.dirname(skillEntryPath)}/agents/openai.yaml`;
  const metadata = parseYamlRecord(
    decodeUtf8(content, displayPath),
    displayPath,
  );
  const policy = metadata['policy'];
  if (policy !== undefined && !isRecord(policy)) {
    throw new PluginSkillDocumentError(
      `plugin skill OpenAI policy must be an object: ${displayPath}`,
    );
  }
  const allowImplicitInvocation = isRecord(policy)
    ? policy['allow_implicit_invocation']
    : undefined;
  if (
    allowImplicitInvocation !== undefined &&
    typeof allowImplicitInvocation !== 'boolean'
  ) {
    throw new PluginSkillDocumentError(
      `plugin skill implicit invocation policy must be boolean: ${displayPath}`,
    );
  }
  const dependencies = metadata['dependencies'];
  if (dependencies !== undefined && !isRecord(dependencies)) {
    throw new PluginSkillDocumentError(
      `plugin skill dependencies must be an object: ${displayPath}`,
    );
  }
  const tools = isRecord(dependencies) ? dependencies['tools'] : undefined;
  if (tools !== undefined && !Array.isArray(tools)) {
    throw new PluginSkillDocumentError(
      `plugin skill tool dependencies must be an array: ${displayPath}`,
    );
  }
  return {
    ...(typeof allowImplicitInvocation === 'boolean'
      ? { allowImplicitInvocation }
      : {}),
    hasToolDependencies: Array.isArray(tools) && tools.length > 0,
  };
}

function parseYamlRecord(
  source: string,
  displayPath: string,
): Record<string, unknown> {
  try {
    const document = parseDocument(source, {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
    });
    const [parseError] = document.errors;
    if (parseError !== undefined) {
      throw parseError;
    }
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!isRecord(value)) {
      throw new Error('YAML root is not an object');
    }
    return value;
  } catch {
    throw new PluginSkillDocumentError(
      `plugin skill YAML is invalid: ${displayPath}`,
    );
  }
}

function readRequiredString(
  record: Record<string, unknown>,
  field: 'name' | 'description',
  displayPath: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PluginSkillDocumentError(
      `plugin skill requires a non-empty ${field}: ${displayPath}`,
    );
  }
  return value.trim();
}

function validateOptionalFrontmatter(
  frontmatter: Record<string, unknown>,
  displayPath: string,
): void {
  const license = frontmatter['license'];
  if (license !== undefined && typeof license !== 'string') {
    throw new PluginSkillDocumentError(
      `plugin skill license must be a string: ${displayPath}`,
    );
  }
  const compatibility = frontmatter['compatibility'];
  if (
    compatibility !== undefined &&
    (typeof compatibility !== 'string' ||
      compatibility.trim().length === 0 ||
      Array.from(compatibility).length > 500)
  ) {
    throw new PluginSkillDocumentError(
      `plugin skill compatibility is invalid: ${displayPath}`,
    );
  }
  const metadata = frontmatter['metadata'];
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new PluginSkillDocumentError(
      `plugin skill metadata must be a mapping: ${displayPath}`,
    );
  }
  // `allowed-tools` is cross-client authoring metadata, not Geulbat authority.
  // Accept its authored shape but never project it into tools or approvals.
}

function decodeUtf8(content: Buffer, displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new PluginSkillDocumentError(
      `plugin skill text resource is not valid UTF-8: ${displayPath}`,
    );
  }
}

function digestBuffer(content: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
