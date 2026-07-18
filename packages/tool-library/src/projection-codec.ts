import { isAbsolute } from 'node:path';

import { stableStringify } from '@geulbat/shared-utils/stable-json';

const TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_PREFIX =
  'export const projectionManifest = ';
const TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_SUFFIX = ';\n';

export interface ToolLibraryProjectionIdentity {
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
}

export interface ToolLibraryProjectionManifest extends ToolLibraryProjectionIdentity {
  sourceRegistryVersion: string;
  runtimeCompatibilityRange: string;
  modelFacingCatalogRef: string;
  importSpecifier: string;
  catalogModule: string;
  searchModule: string;
  searchRuntimeModule: string;
  indexDeclarationModule: string;
  allowedPublicNames: readonly string[];
  allowedRegistryNames: readonly string[];
  allowedCallbackNames: readonly string[];
  importableModules: readonly ToolLibraryProjectionImportableModule[];
}

export interface ToolLibraryProjectionPin extends ToolLibraryProjectionManifest {
  projectionDirectory: string;
}

export type ToolLibraryProjectionMountedModuleRole =
  | 'index'
  | 'catalog'
  | 'search'
  | 'search_runtime'
  | 'manifest'
  | 'index_declaration'
  | 'signature'
  | 'signature_declaration'
  | 'wrapper'
  | 'wrapper_declaration';

export interface ToolLibraryProjectionImportableModule {
  specifier: string;
  module: string;
  role: ToolLibraryProjectionMountedModuleRole;
}

type ReadToolLibraryProjectionManifestResult =
  | {
      ok: true;
      manifest: ToolLibraryProjectionManifest;
    }
  | {
      ok: false;
      reason:
        | 'manifest_read_failed'
        | 'manifest_parse_failed'
        | 'manifest_invalid'
        | 'manifest_mismatch';
      message: string;
    };

type ReadToolLibraryProjectionPinResult =
  | {
      ok: true;
      pin: ToolLibraryProjectionPin;
    }
  | {
      ok: false;
      reason:
        | 'pin_read_failed'
        | 'pin_parse_failed'
        | 'pin_invalid'
        | 'pin_mismatch';
      message: string;
    };

export function serializeToolLibraryProjectionManifestModule(
  manifest: ToolLibraryProjectionManifest,
): string {
  return `${TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_PREFIX}${stableStringify(manifest)}${TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_SUFFIX}`;
}

export function verifyToolLibraryProjectionPinMatchesManifest(args: {
  pin: ToolLibraryProjectionPin;
  manifest: ToolLibraryProjectionManifest;
}): ReadToolLibraryProjectionPinResult {
  const pinManifest: ToolLibraryProjectionManifest = {
    sdkVersion: args.pin.sdkVersion,
    sdkProjectionHash: args.pin.sdkProjectionHash,
    sourceRegistryVersion: args.pin.sourceRegistryVersion,
    policyId: args.pin.policyId,
    runtimeCompatibilityRange: args.pin.runtimeCompatibilityRange,
    modelFacingCatalogRef: args.pin.modelFacingCatalogRef,
    importSpecifier: args.pin.importSpecifier,
    catalogModule: args.pin.catalogModule,
    searchModule: args.pin.searchModule,
    searchRuntimeModule: args.pin.searchRuntimeModule,
    indexDeclarationModule: args.pin.indexDeclarationModule,
    allowedPublicNames: args.pin.allowedPublicNames,
    allowedRegistryNames: args.pin.allowedRegistryNames,
    allowedCallbackNames: args.pin.allowedCallbackNames,
    importableModules: args.pin.importableModules,
  };
  if (stableStringify(pinManifest) !== stableStringify(args.manifest)) {
    return {
      ok: false,
      reason: 'pin_mismatch',
      message: 'Tool library projection pin does not match pinned manifest',
    };
  }
  return { ok: true, pin: args.pin };
}

export function verifyToolLibraryProjectionManifest(args: {
  manifest: ToolLibraryProjectionManifest;
  expectedManifest: ToolLibraryProjectionManifest;
}): ReadToolLibraryProjectionManifestResult {
  if (
    stableStringify(args.manifest) !== stableStringify(args.expectedManifest)
  ) {
    return {
      ok: false,
      reason: 'manifest_mismatch',
      message:
        'Tool library projection manifest does not match expected projection',
    };
  }
  return { ok: true, manifest: args.manifest };
}

export function parseToolLibraryProjectionPin(
  source: string,
): ReadToolLibraryProjectionPinResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      ok: false,
      reason: 'pin_parse_failed',
      message: 'Tool library projection pin JSON is invalid',
    };
  }

  const pin = readToolLibraryProjectionPinValue(parsed);
  if (pin === null) {
    return {
      ok: false,
      reason: 'pin_invalid',
      message: 'Tool library projection pin shape is invalid',
    };
  }

  return { ok: true, pin };
}

export function parseToolLibraryProjectionManifestModule(
  source: string,
): ReadToolLibraryProjectionManifestResult {
  if (
    !source.startsWith(TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_PREFIX) ||
    !source.endsWith(TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_SUFFIX)
  ) {
    return {
      ok: false,
      reason: 'manifest_parse_failed',
      message: 'Tool library projection manifest module is invalid',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      source.slice(
        TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_PREFIX.length,
        -TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE_SUFFIX.length,
      ),
    );
  } catch {
    return {
      ok: false,
      reason: 'manifest_parse_failed',
      message: 'Tool library projection manifest JSON is invalid',
    };
  }

  const manifest = readToolLibraryProjectionManifestValue(parsed);
  if (manifest === null) {
    return {
      ok: false,
      reason: 'manifest_invalid',
      message: 'Tool library projection manifest shape is invalid',
    };
  }

  return { ok: true, manifest };
}

function readToolLibraryProjectionPinValue(
  value: unknown,
): ToolLibraryProjectionPin | null {
  const record = readNonArrayObject(value);
  if (record === null) {
    return null;
  }

  const manifest = readToolLibraryProjectionManifestValue(record);
  const projectionDirectory = readProjectionDirectoryField(
    record,
    'projectionDirectory',
  );
  if (manifest === null || projectionDirectory === null) {
    return null;
  }

  return {
    ...manifest,
    projectionDirectory,
  };
}

function readToolLibraryProjectionManifestValue(
  value: unknown,
): ToolLibraryProjectionManifest | null {
  const record = readNonArrayObject(value);
  if (record === null) {
    return null;
  }

  const sdkVersion = readStringField(record, 'sdkVersion');
  const sdkProjectionHash = readProjectionHashField(
    record,
    'sdkProjectionHash',
  );
  const sourceRegistryVersion = readStringField(
    record,
    'sourceRegistryVersion',
  );
  const policyId = readStringField(record, 'policyId');
  const runtimeCompatibilityRange = readStringField(
    record,
    'runtimeCompatibilityRange',
  );
  const modelFacingCatalogRef = readStringField(
    record,
    'modelFacingCatalogRef',
  );
  const importSpecifier = readStringField(record, 'importSpecifier');
  const catalogModule = readStringField(record, 'catalogModule');
  const searchModule = readStringField(record, 'searchModule');
  const searchRuntimeModule = readStringField(record, 'searchRuntimeModule');
  const indexDeclarationModule = readStringField(
    record,
    'indexDeclarationModule',
  );
  const allowedPublicNames = readStringArrayField(record, 'allowedPublicNames');
  const allowedRegistryNames = readStringArrayField(
    record,
    'allowedRegistryNames',
  );
  const allowedCallbackNames = readStringArrayField(
    record,
    'allowedCallbackNames',
  );
  const importableModules = readImportableModulesField(
    record,
    'importableModules',
  );

  if (
    sdkVersion === null ||
    sdkProjectionHash === null ||
    sourceRegistryVersion === null ||
    policyId === null ||
    runtimeCompatibilityRange === null ||
    modelFacingCatalogRef === null ||
    importSpecifier === null ||
    catalogModule === null ||
    searchModule === null ||
    searchRuntimeModule === null ||
    indexDeclarationModule === null ||
    allowedPublicNames === null ||
    allowedRegistryNames === null ||
    allowedCallbackNames === null ||
    importableModules === null
  ) {
    return null;
  }

  return {
    sdkVersion,
    sdkProjectionHash,
    sourceRegistryVersion,
    policyId,
    runtimeCompatibilityRange,
    modelFacingCatalogRef,
    importSpecifier,
    catalogModule,
    searchModule,
    searchRuntimeModule,
    indexDeclarationModule,
    allowedPublicNames,
    allowedRegistryNames,
    allowedCallbackNames,
    importableModules,
  };
}

function readProjectionDirectoryField(
  record: object,
  fieldName: string,
): string | null {
  const value: unknown = Reflect.get(record, fieldName);
  return typeof value === 'string' && /^sha256-[0-9a-f]{64}$/u.test(value)
    ? value
    : null;
}

function readNonArrayObject(value: unknown): object | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readStringField(record: object, fieldName: string): string | null {
  const value: unknown = Reflect.get(record, fieldName);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProjectionHashField(
  record: object,
  fieldName: string,
): `sha256:${string}` | null {
  const value: unknown = Reflect.get(record, fieldName);
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    return null;
  }
  return `sha256:${value.slice('sha256:'.length)}`;
}

function readStringArrayField(
  record: object,
  fieldName: string,
): readonly string[] | null {
  const value: unknown = Reflect.get(record, fieldName);
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    return null;
  }
  return value;
}

function readImportableModulesField(
  record: object,
  fieldName: string,
): readonly ToolLibraryProjectionImportableModule[] | null {
  const value: unknown = Reflect.get(record, fieldName);
  if (!Array.isArray(value)) {
    return null;
  }

  const seenSpecifiers = new Set<string>();
  const seenModules = new Set<string>();
  const modules: ToolLibraryProjectionImportableModule[] = [];
  for (const entry of value) {
    const module = readImportableModuleValue(entry);
    if (
      module === null ||
      seenSpecifiers.has(module.specifier) ||
      seenModules.has(module.module)
    ) {
      return null;
    }
    seenSpecifiers.add(module.specifier);
    seenModules.add(module.module);
    modules.push(module);
  }
  return modules;
}

function readImportableModuleValue(
  value: unknown,
): ToolLibraryProjectionImportableModule | null {
  const record = readNonArrayObject(value);
  if (record === null) {
    return null;
  }
  const specifier = readStringField(record, 'specifier');
  const module = readStringField(record, 'module');
  const role = readMountedModuleRoleField(record, 'role');
  if (
    specifier === null ||
    module === null ||
    role === null ||
    !isValidProjectionRelativePath(module)
  ) {
    return null;
  }
  return { specifier, module, role };
}

function readMountedModuleRoleField(
  record: object,
  fieldName: string,
): ToolLibraryProjectionMountedModuleRole | null {
  const value: unknown = Reflect.get(record, fieldName);
  return typeof value === 'string' && isMountedModuleRole(value) ? value : null;
}

function isMountedModuleRole(
  value: string,
): value is ToolLibraryProjectionMountedModuleRole {
  return (
    value === 'index' ||
    value === 'catalog' ||
    value === 'search' ||
    value === 'search_runtime' ||
    value === 'manifest' ||
    value === 'index_declaration' ||
    value === 'signature' ||
    value === 'signature_declaration' ||
    value === 'wrapper' ||
    value === 'wrapper_declaration'
  );
}

function isValidProjectionRelativePath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    return false;
  }

  return relativePath
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}
