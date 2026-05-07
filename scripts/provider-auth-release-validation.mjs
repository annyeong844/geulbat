import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BUNDLED_PROVIDER_AUTH_CONFIG_PATH =
  'apps/daemon/provider-auth.config.json';

const PROVIDER_AUTH_ENV_OVERRIDES = [
  'PROVIDER_AUTH_CLIENT_ID',
  'PROVIDER_AUTH_CLIENT_SECRET',
  'GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH',
  'GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH',
  'GEULBAT_PROVIDER_AUTH_FILE_PATH',
];

const MODULE_RESOLUTION_ENV_OVERRIDES = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'TS_NODE_PROJECT',
  'TS_NODE_TRANSPILE_ONLY',
];

const LOCAL_OVERRIDE_PATHS = [
  '.env',
  '.env.local',
  'apps/daemon/.env.local',
  '.geulbat/dev-auth-token',
];

const CREDENTIAL_MATERIAL_PATHS = ['provider.json', '.geulbat/auth'];

const PLACEHOLDER_CLIENT_IDS = new Set([
  'REPLACE_WITH_PUBLIC_PROVIDER_AUTH_CLIENT_ID_AT_PACKAGE_TIME',
  'REPLACE_WITH_PUBLIC_PROVIDER_AUTH_CLIENT_ID',
  'public-provider-auth-client-id',
]);

export async function validateProviderAuthReleaseArtifact(options) {
  const violations =
    await collectProviderAuthReleaseValidationViolations(options);
  if (violations.length === 0) {
    return;
  }

  const summary = violations
    .map((violation) => `${violation.code}: ${violation.message}`)
    .join('\n');
  throw new Error(`provider auth release validation failed:\n${summary}`);
}

export async function readApprovedProviderAuthClientIdFile(filePath) {
  const metadataPath = path.resolve(
    readRequiredString({ filePath }, 'filePath'),
  );
  let contents;
  try {
    contents = await readFile(metadataPath, 'utf8');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      throw new Error(`approved client id file is missing: ${filePath}`);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `approved client id file is not valid JSON: ${error.message}`,
    );
  }

  return readApprovedProviderAuthClientIds(parsed, filePath);
}

export async function collectProviderAuthReleaseValidationViolations(options) {
  const artifactRoot = path.resolve(
    readRequiredString(options, 'artifactRoot'),
  );
  const approvedClientIds = new Set(options.approvedClientIds ?? []);
  const env = options.env ?? process.env;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const bundledConfigPath =
    options.bundledConfigPath ?? DEFAULT_BUNDLED_PROVIDER_AUTH_CONFIG_PATH;

  const violations = [
    ...collectEnvOverrideViolations(env),
    ...collectModuleResolutionEnvViolations(env),
    ...(await collectDefaultInstalledConfigViolations(homeDir)),
    ...(await collectLocalOverrideMaterialViolations(artifactRoot)),
    ...(await collectCredentialMaterialViolations(artifactRoot)),
  ];

  const clientIdResult = await readBundledProviderAuthClientId(
    artifactRoot,
    bundledConfigPath,
  );
  if (!clientIdResult.ok) {
    violations.push(clientIdResult.violation);
    return violations;
  }

  const clientId = clientIdResult.clientId;
  if (isPlaceholderClientId(clientId)) {
    violations.push({
      code: 'client_id_placeholder',
      message: `bundled provider auth client id is a placeholder: ${clientId}`,
      path: bundledConfigPath,
    });
    return violations;
  }

  if (!approvedClientIds.has(clientId)) {
    violations.push({
      code: 'client_id_unapproved',
      message:
        'bundled provider auth client id is not approved for this release channel',
      path: bundledConfigPath,
    });
  }

  return violations;
}

function readApprovedProviderAuthClientIds(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `approved client id file must be an object with providerAuthClientIds: ${filePath}`,
    );
  }
  const clientIds = value.providerAuthClientIds;
  if (!Array.isArray(clientIds)) {
    throw new Error(
      `approved client id file must contain providerAuthClientIds array: ${filePath}`,
    );
  }

  const approvedClientIds = [];
  for (const clientId of clientIds) {
    const trimmed = trimToNull(clientId);
    if (!trimmed) {
      throw new Error(
        `approved client id file contains an empty client id: ${filePath}`,
      );
    }
    if (isPlaceholderClientId(trimmed)) {
      throw new Error(
        `approved client id file contains a placeholder client id: ${trimmed}`,
      );
    }
    approvedClientIds.push(trimmed);
  }

  if (approvedClientIds.length === 0) {
    throw new Error(
      `approved client id file must contain at least one client id: ${filePath}`,
    );
  }

  return [...new Set(approvedClientIds)];
}

function collectEnvOverrideViolations(env) {
  return PROVIDER_AUTH_ENV_OVERRIDES.flatMap((name) => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return [];
    }
    return [
      {
        code: 'env_override_present',
        message: `release validation env override must be unset: ${name}`,
      },
    ];
  });
}

function collectModuleResolutionEnvViolations(env) {
  return MODULE_RESOLUTION_ENV_OVERRIDES.flatMap((name) => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return [];
    }
    return [
      {
        code: 'module_resolution_env_present',
        message: `release validation module resolution env override must be unset: ${name}`,
      },
    ];
  });
}

async function collectDefaultInstalledConfigViolations(homeDir) {
  const installedConfigPath = path.join(
    homeDir,
    '.geulbat',
    'config',
    'provider-auth.json',
  );
  if (!(await pathExists(installedConfigPath))) {
    return [];
  }
  return [
    {
      code: 'default_installed_config_present',
      message:
        'release validation home directory contains a default installed provider auth config',
      path: installedConfigPath,
    },
  ];
}

async function collectCredentialMaterialViolations(artifactRoot) {
  const relativePaths = await collectExistingPaths(
    artifactRoot,
    CREDENTIAL_MATERIAL_PATHS,
  );
  return relativePaths.map((relativePath) => ({
    code: 'credential_material_present',
    message: `release artifact contains provider credential material: ${relativePath}`,
    path: relativePath,
  }));
}

async function collectLocalOverrideMaterialViolations(artifactRoot) {
  const relativePaths = await collectExistingPaths(
    artifactRoot,
    LOCAL_OVERRIDE_PATHS,
  );
  return relativePaths.map((relativePath) => ({
    code: 'local_override_material_present',
    message: `release artifact contains source-checkout local override material: ${relativePath}`,
    path: relativePath,
  }));
}

async function collectExistingPaths(artifactRoot, relativePaths) {
  const checks = await Promise.all(
    relativePaths.map(async (relativePath) => ({
      exists: await pathExists(path.join(artifactRoot, relativePath)),
      relativePath,
    })),
  );
  return checks
    .filter((check) => check.exists)
    .map((check) => check.relativePath);
}

async function readBundledProviderAuthClientId(
  artifactRoot,
  bundledConfigPath,
) {
  const configPath = path.join(artifactRoot, bundledConfigPath);
  let contents;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {
        ok: false,
        violation: {
          code: 'bundled_config_missing',
          message: `bundled provider auth config is missing: ${bundledConfigPath}`,
          path: bundledConfigPath,
        },
      };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return {
      ok: false,
      violation: {
        code: 'bundled_config_invalid',
        message: `bundled provider auth config is not valid JSON: ${error.message}`,
        path: bundledConfigPath,
      },
    };
  }

  const clientId = readClientId(parsed);
  if (!clientId) {
    return {
      ok: false,
      violation: {
        code: 'client_id_unresolved',
        message: 'bundled provider auth config does not resolve a client id',
        path: bundledConfigPath,
      },
    };
  }

  return {
    clientId,
    ok: true,
  };
}

function readClientId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value;
  return trimToNull(record.clientId) ?? trimToNull(record.client_id);
}

function isPlaceholderClientId(clientId) {
  return (
    PLACEHOLDER_CLIENT_IDS.has(clientId) || clientId.includes('REPLACE_WITH_')
  );
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function readRequiredString(options, key) {
  const value = options?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value;
}

function trimToNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isNodeErrorWithCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
