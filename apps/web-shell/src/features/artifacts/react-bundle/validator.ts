import {
  decodeReactBundleInlineSourceInput,
  type ReactBundleInlineSourceInput,
  type ReactBundleRuntimeDependencies,
  type ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';

import {
  validateReactBundleDependencyUrl,
  validateReactBundleEntryUrl,
} from './entry-url-policy.js';
import type {
  ArtifactValidationFailure,
  ArtifactPolicyOrBootFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

type ReactBundleArtifactPayloadValidation =
  | ArtifactValidationSuccess<{ manifest: ReactBundleRuntimeManifest }>
  | ArtifactPolicyOrBootFailure;

type ReactBundleArtifactInputPayloadValidation =
  | ArtifactValidationSuccess<{
      kind: 'manifest';
      manifest: ReactBundleRuntimeManifest;
    }>
  | ArtifactValidationSuccess<{
      kind: 'inline_source';
      input: ReactBundleInlineSourceInput;
    }>
  | ArtifactValidationFailure<
      'boot_failed' | 'policy_blocked' | 'sanitize_rejected'
    >;

export function validateReactBundleArtifactPayload(
  payload: string,
): ReactBundleArtifactPayloadValidation {
  if (!payload.trim()) {
    return reject('react bundle artifact payload is empty');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(payload);
  } catch {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (!isPlainRecord(manifest)) {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (looksLikeInlineSourceProjectManifest(manifest)) {
    return reject(
      'react bundle inline source manifests with files/entry are unsupported; current runtime requires {"entryUrl":"..."} for a prebuilt bundle',
    );
  }

  return readReactBundleRuntimeManifest(manifest);
}

export function readReactBundleArtifactInputPayload(
  payload: string,
): ReactBundleArtifactInputPayloadValidation {
  if (!payload.trim()) {
    return reject('react bundle artifact payload is empty');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(payload);
  } catch {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (!isPlainRecord(manifest)) {
    return reject('react bundle payload must be a JSON manifest object');
  }

  const inlineInput = decodeReactBundleInlineSourceInput(manifest);
  if (inlineInput.ok) {
    return {
      ok: true,
      kind: 'inline_source',
      input: inlineInput.value,
    };
  }

  const runtimeManifest = readReactBundleRuntimeManifest(manifest);
  if (!runtimeManifest.ok) {
    return runtimeManifest;
  }

  return {
    ok: true,
    kind: 'manifest',
    manifest: runtimeManifest.manifest,
  };
}

function readReactBundleRuntimeManifest(
  manifest: Record<string, unknown>,
): ReactBundleArtifactPayloadValidation {
  if (typeof manifest['entryUrl'] !== 'string') {
    return reject('react bundle manifest requires a string entryUrl');
  }

  const entryUrlValidation = validateReactBundleEntryUrl(manifest['entryUrl']);
  if (!entryUrlValidation.ok) {
    return entryUrlValidation;
  }

  const runtimeDependencies = readRuntimeDependencies(
    manifest['runtimeDependencies'],
  );
  if (!runtimeDependencies.ok) {
    return runtimeDependencies;
  }

  return {
    ok: true,
    manifest: {
      entryUrl: entryUrlValidation.entryUrl,
      ...(runtimeDependencies.value
        ? { runtimeDependencies: runtimeDependencies.value }
        : {}),
    },
  };
}

function readRuntimeDependencies(
  value: unknown,
):
  | { ok: true; value?: ReactBundleRuntimeDependencies }
  | ArtifactPolicyOrBootFailure {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isPlainRecord(value)) {
    return reject('react bundle runtimeDependencies must be an object');
  }

  const unsupportedKey = Object.keys(value).find(
    (key) => key !== 'importMap' && key !== 'stylesheets',
  );
  if (unsupportedKey) {
    return reject(
      `react bundle runtimeDependencies does not support ${unsupportedKey}`,
    );
  }

  const importMap = readRuntimeImportMap(value.importMap);
  if (!importMap.ok) {
    return importMap;
  }

  const stylesheets = readRuntimeStylesheets(value.stylesheets);
  if (!stylesheets.ok) {
    return stylesheets;
  }

  const dependencies: ReactBundleRuntimeDependencies = {};
  if (
    importMap.value &&
    Object.keys(importMap.value.imports ?? {}).length > 0
  ) {
    dependencies.importMap = importMap.value;
  }
  if (stylesheets.value && stylesheets.value.length > 0) {
    dependencies.stylesheets = stylesheets.value;
  }

  return Object.keys(dependencies).length > 0
    ? { ok: true, value: dependencies }
    : { ok: true };
}

function readRuntimeImportMap(
  value: unknown,
):
  | { ok: true; value?: ReactBundleRuntimeDependencies['importMap'] }
  | ArtifactPolicyOrBootFailure {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isPlainRecord(value)) {
    return reject(
      'react bundle runtimeDependencies.importMap must be an object',
    );
  }

  const unsupportedKey = Object.keys(value).find((key) => key !== 'imports');
  if (unsupportedKey) {
    return reject(
      'react bundle runtimeDependencies.importMap supports imports only',
    );
  }

  const imports = value.imports;
  if (imports === undefined) {
    return { ok: true };
  }
  if (!isPlainRecord(imports)) {
    return reject(
      'react bundle runtimeDependencies.importMap.imports must be an object',
    );
  }

  const normalizedImports: Record<string, string> = {};
  for (const [specifier, rawUrl] of Object.entries(imports)) {
    if (!specifier.trim()) {
      return reject(
        'react bundle runtime dependency import specifier must be non-empty',
      );
    }
    if (/[\u0000-\u001f\u007f]/u.test(specifier)) {
      return reject(
        'react bundle runtime dependency import specifier must not contain control characters',
      );
    }
    if (typeof rawUrl !== 'string') {
      return reject(
        'react bundle runtimeDependencies.importMap.imports values must be strings',
      );
    }
    const urlValidation = validateReactBundleDependencyUrl(rawUrl);
    if (!urlValidation.ok) {
      return urlValidation;
    }
    normalizedImports[specifier] = urlValidation.url;
  }

  return {
    ok: true,
    value:
      Object.keys(normalizedImports).length > 0
        ? { imports: normalizedImports }
        : undefined,
  };
}

function readRuntimeStylesheets(
  value: unknown,
): { ok: true; value?: string[] } | ArtifactPolicyOrBootFailure {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return reject(
      'react bundle runtimeDependencies.stylesheets must be an array',
    );
  }

  const stylesheets: string[] = [];
  for (const rawUrl of value) {
    if (typeof rawUrl !== 'string') {
      return reject(
        'react bundle runtimeDependencies.stylesheets entries must be strings',
      );
    }
    const urlValidation = validateReactBundleDependencyUrl(rawUrl);
    if (!urlValidation.ok) {
      return urlValidation;
    }
    stylesheets.push(urlValidation.url);
  }

  return stylesheets.length > 0
    ? {
        ok: true,
        value: stylesheets,
      }
    : { ok: true };
}

function looksLikeInlineSourceProjectManifest(
  manifest: Record<string, unknown>,
): boolean {
  return (
    isPlainRecord(manifest['files']) && typeof manifest['entry'] === 'string'
  );
}

function reject(detail: string): ArtifactPolicyOrBootFailure {
  return {
    ok: false,
    code: 'boot_failed',
    detail,
  };
}
