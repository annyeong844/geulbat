import { isRecord } from '@geulbat/protocol/runtime-utils';
import { posix } from 'node:path';

import {
  isNonEmptyString,
  PluginPackageAdmissionError,
} from './plugin-package-admission-contract.js';
import { normalizeDeclaredPackagePath } from './plugin-package-paths.js';
import type { PackageEntry } from './plugin-package-secure-fs.js';

export const MANIFEST_RELATIVE_PATH = '.codex-plugin/plugin.json';
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function validateManifest(manifest: Record<string, unknown>): {
  name: string;
  version: string;
  description: string;
  displayName: string;
} {
  const { name, version, description } = manifest;
  if (
    !isNonEmptyString(name) ||
    !PLUGIN_NAME_PATTERN.test(name) ||
    !isNonEmptyString(version) ||
    !SEMVER_PATTERN.test(version) ||
    !isNonEmptyString(description)
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest requires a valid name, strict semver version, and description',
    );
  }
  if (manifest.author !== undefined && !isValidAuthor(manifest.author)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest author has an invalid shape',
    );
  }
  if (manifest.interface !== undefined && !isRecord(manifest.interface)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest interface must be an object',
    );
  }
  const displayName = isRecord(manifest.interface)
    ? manifest.interface['displayName']
    : undefined;
  if (displayName !== undefined && !isNonEmptyString(displayName)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest interface.displayName must be a non-empty string',
    );
  }
  return {
    name,
    version,
    description,
    displayName: displayName ?? name,
  };
}

export function readPluginIconPath(
  manifest: Record<string, unknown>,
  entries: Map<string, PackageEntry>,
): string | null {
  if (!isRecord(manifest.interface)) {
    return null;
  }
  for (const field of ['logo', 'composerIcon'] as const) {
    const value = manifest.interface[field];
    if (value === undefined) {
      continue;
    }
    if (!isNonEmptyString(value)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} must be a relative file path`,
      );
    }
    const relativePath = normalizeDeclaredPackagePath(
      value,
      `interface.${field}`,
    );
    if (entries.get(relativePath)?.kind !== 'file') {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} file does not exist`,
      );
    }
    if (pluginIconContentType(relativePath) === null) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} has an unsupported image type`,
      );
    }
    return relativePath;
  }
  return null;
}

export function pluginIconContentType(relativePath: string): string | null {
  const extension = posix.extname(relativePath).toLocaleLowerCase('en-US');
  switch (extension) {
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

function isValidAuthor(value: unknown): boolean {
  return (
    isNonEmptyString(value) ||
    (isRecord(value) && isNonEmptyString(value['name']))
  );
}
