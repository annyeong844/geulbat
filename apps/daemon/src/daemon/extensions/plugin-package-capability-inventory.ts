import type {
  PluginCapabilityKind,
  PluginCapabilityView,
} from '@geulbat/protocol/plugins';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import { basename, posix } from 'node:path';

import {
  parsePluginSkillDocument,
  PluginSkillDocumentError,
  type InspectedPluginSkill,
} from './plugin-skill-runtime.js';
import {
  assertNoEmbeddedCredentials,
  isNonEmptyString,
  PluginPackageAdmissionError,
} from './plugin-package-admission-contract.js';
import {
  isPathWithin,
  normalizeDeclaredPackagePath,
  toAbsolutePackagePath,
} from './plugin-package-paths.js';
import { MANIFEST_RELATIVE_PATH } from './plugin-package-manifest.js';
import {
  addInspectedMcpServerEntries,
  type InspectedMcpServerRecord,
  type InspectedPluginMcpServer,
} from './plugin-package-mcp-inspection.js';
import {
  readJsonObject,
  readPackageBuffer,
  type PackageEntry,
} from './plugin-package-secure-fs.js';

const COMPONENT_SUPPORT: Record<
  Exclude<PluginCapabilityKind, 'mcpServers'>,
  PluginCapabilityView['supportStatus']
> = {
  skills: 'supported',
  apps: 'unsupported',
  hooks: 'unsupported',
};

export async function inventoryCapabilities(args: {
  packageRoot: string;
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Promise<{
  capabilities: PluginCapabilityView[];
  skills: InspectedPluginSkill[];
  mcpServers: InspectedPluginMcpServer[];
}> {
  const counts = new Map<PluginCapabilityKind, number>();

  const skills = await inventoryPluginSkills(args);
  if (skills.length > 0) {
    counts.set('skills', skills.length);
  }

  const { servers: mcpServers, supportStatus: mcpSupportStatus } =
    await inventoryPluginMcpServers(args);
  if (mcpServers.length > 0) {
    counts.set('mcpServers', mcpServers.length);
  }

  const appNames = await inventoryPluginApps(args);
  if (appNames.size > 0) {
    counts.set('apps', appNames.size);
  }

  const hookEntries = inventoryPluginHooks(args);
  if (hookEntries.size > 0) {
    counts.set('hooks', hookEntries.size);
  }

  return {
    capabilities: (
      ['skills', 'mcpServers', 'apps', 'hooks'] as const
    ).flatMap<PluginCapabilityView>((kind) => {
      const itemCount = counts.get(kind);
      if (itemCount === undefined) {
        return [];
      }
      if (kind === 'mcpServers') {
        if (mcpSupportStatus === undefined) {
          throw new PluginPackageAdmissionError(
            'invalid_request',
            'plugin MCP inventory support status is unavailable',
          );
        }
        return [{ kind, supportStatus: mcpSupportStatus, itemCount }];
      }
      return [
        {
          kind,
          supportStatus: COMPONENT_SUPPORT[kind],
          itemCount,
        },
      ];
    }),
    skills,
    mcpServers,
  };
}

async function inventoryPluginSkills(args: {
  packageRoot: string;
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Promise<InspectedPluginSkill[]> {
  const skillPaths = collectComponentPaths({
    declared: args.manifest['skills'],
    field: 'skills',
    conventionalPath: 'skills',
    entries: args.entries,
    requiredKind: 'directory',
  });
  const skillEntryPaths = new Set(
    [...args.entries.values()]
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          basename(entry.relativePath) === 'SKILL.md' &&
          skillPaths.some((skillPath) => {
            const relativeSkillPath = posix.relative(
              skillPath,
              entry.relativePath,
            );
            const segments = relativeSkillPath.split('/');
            return (
              segments.length === 2 &&
              segments[0] !== '' &&
              segments[1] === 'SKILL.md'
            );
          }),
      )
      .map((entry) => entry.relativePath),
  );
  const skills: InspectedPluginSkill[] = [];
  for (const entryPath of [...skillEntryPaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const directoryPath = posix.dirname(entryPath);
    const resourcePaths = [...args.entries.values()]
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          entry.relativePath !== entryPath &&
          isPathWithin(entry.relativePath, directoryPath),
      )
      .map((entry) => entry.relativePath);
    const openAiMetadataPath = `${directoryPath}/agents/openai.yaml`;
    const openAiMetadataEntry = args.entries.get(openAiMetadataPath);
    try {
      skills.push(
        parsePluginSkillDocument({
          entryPath,
          content: await readPackageBuffer(
            toAbsolutePackagePath(args.packageRoot, entryPath),
            args.entries.get(entryPath)!,
          ),
          ...(openAiMetadataEntry?.kind === 'file'
            ? {
                openAiMetadata: await readPackageBuffer(
                  toAbsolutePackagePath(args.packageRoot, openAiMetadataPath),
                  openAiMetadataEntry,
                ),
              }
            : {}),
          resourcePaths,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof PluginSkillDocumentError) {
        throw new PluginPackageAdmissionError('invalid_request', error.message);
      }
      throw error;
    }
  }
  return skills;
}

async function inventoryPluginMcpServers(args: {
  packageRoot: string;
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Promise<{
  servers: InspectedPluginMcpServer[];
  supportStatus: PluginCapabilityView['supportStatus'] | undefined;
}> {
  const mcpServersByIdentity = new Map<string, InspectedMcpServerRecord>();
  const declaredMcp = args.manifest['mcpServers'];
  if (isRecord(declaredMcp)) {
    addInspectedMcpServerEntries({
      destination: mcpServersByIdentity,
      entries: declaredMcp,
      sourcePath: MANIFEST_RELATIVE_PATH,
      packageEntries: args.entries,
    });
  } else if (declaredMcp !== undefined && !isNonEmptyString(declaredMcp)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest mcpServers must be a relative path or object',
    );
  }
  const mcpPaths = collectComponentPaths({
    declared: isNonEmptyString(declaredMcp) ? declaredMcp : undefined,
    field: 'mcpServers',
    conventionalPath: '.mcp.json',
    entries: args.entries,
    requiredKind: 'file',
  });
  for (const mcpPath of mcpPaths) {
    const config = await readJsonObject(
      toAbsolutePackagePath(args.packageRoot, mcpPath),
      mcpPath,
      args.entries.get(mcpPath)!,
    );
    const wrappedServers = config['mcpServers'];
    if (wrappedServers !== undefined && !isRecord(wrappedServers)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin MCP declaration has an invalid shape: ${mcpPath}`,
      );
    }
    assertNoEmbeddedCredentials(config, mcpPath, {
      rootKeysAreComponentIdentities: wrappedServers === undefined,
      rootComponentIdentityFields: ['mcpServers'],
    });
    addInspectedMcpServerEntries({
      destination: mcpServersByIdentity,
      entries: isRecord(wrappedServers) ? wrappedServers : config,
      sourcePath: mcpPath,
      packageEntries: args.entries,
    });
  }
  const servers = [...mcpServersByIdentity.values()]
    .map((entry) => entry.inspected)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.sourcePath.localeCompare(right.sourcePath),
    );
  let supportStatus: PluginCapabilityView['supportStatus'] | undefined;
  if (servers.length > 0) {
    const supportedCount = servers.filter(
      (server) => server.supportStatus === 'supported',
    ).length;
    supportStatus =
      supportedCount === servers.length
        ? 'supported'
        : supportedCount === 0
          ? 'not-yet-supported'
          : 'partially-supported';
  }
  return { servers, supportStatus };
}

async function inventoryPluginApps(args: {
  packageRoot: string;
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Promise<Set<string>> {
  const appNames = new Set<string>();
  const appPaths = collectComponentPaths({
    declared: args.manifest['apps'],
    field: 'apps',
    conventionalPath: '.app.json',
    entries: args.entries,
    requiredKind: 'file',
  });
  for (const appsPath of appPaths) {
    const config = await readJsonObject(
      toAbsolutePackagePath(args.packageRoot, appsPath),
      appsPath,
      args.entries.get(appsPath)!,
    );
    const apps = config['apps'];
    if (!isRecord(apps)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin App declaration has an invalid shape: ${appsPath}`,
      );
    }
    assertNoEmbeddedCredentials(config, appsPath, {
      rootComponentIdentityFields: ['apps'],
    });
    addNamedComponentEntries(appNames, apps, appsPath);
  }
  return appNames;
}

function inventoryPluginHooks(args: {
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Set<string> {
  const hookPaths = collectComponentPaths({
    declared: args.manifest['hooks'],
    field: 'hooks',
    conventionalPath: 'hooks',
    entries: args.entries,
  });
  const hookEntries = new Set<string>();
  for (const hooksPath of hookPaths) {
    const entry = args.entries.get(hooksPath)!;
    if (entry.kind === 'file') {
      hookEntries.add(hooksPath);
      continue;
    }
    for (const candidate of args.entries.values()) {
      if (
        candidate.kind === 'file' &&
        isPathWithin(candidate.relativePath, hooksPath)
      ) {
        hookEntries.add(candidate.relativePath);
      }
    }
  }
  return hookEntries;
}

function collectComponentPaths(args: {
  declared: unknown;
  field: 'skills' | 'mcpServers' | 'apps' | 'hooks';
  conventionalPath: string;
  entries: Map<string, PackageEntry>;
  requiredKind?: PackageEntry['kind'];
}): string[] {
  if (args.declared !== undefined && !isNonEmptyString(args.declared)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest ${args.field} declaration must be a relative path`,
    );
  }
  const paths = new Set<string>();
  if (isNonEmptyString(args.declared)) {
    paths.add(normalizeDeclaredPackagePath(args.declared, args.field));
  }
  if (args.entries.has(args.conventionalPath)) {
    paths.add(args.conventionalPath);
  }
  for (const componentPath of paths) {
    const entry = args.entries.get(componentPath);
    if (!entry) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest component path does not exist: ${args.field}`,
      );
    }
    if (args.requiredKind && entry.kind !== args.requiredKind) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest component has the wrong file kind: ${args.field}`,
      );
    }
  }
  return [...paths];
}

function addNamedComponentEntries(
  names: Set<string>,
  entries: Record<string, unknown>,
  sourceLabel: string,
): void {
  for (const [name, entry] of Object.entries(entries)) {
    if (!isNonEmptyString(name) || !isRecord(entry)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin component entries require non-empty names and object values: ${sourceLabel}`,
      );
    }
    names.add(name);
  }
}
