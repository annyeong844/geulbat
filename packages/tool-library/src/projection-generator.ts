import { stableStringify } from '@geulbat/shared-utils/stable-json';
import { toPascalCase } from '@geulbat/shared-utils/identifier-naming';

import {
  serializeToolLibraryProjectionManifestModule,
  type ToolLibraryProjectionImportableModule,
  type ToolLibraryProjectionManifest,
} from './projection-codec.js';
import type {
  ToolLibraryProjectionFile,
  ToolLibraryProjectionGeneratedSignature,
  ToolLibraryProjectionGeneratedTool,
} from './projection-descriptor.js';
import {
  isToolLibraryProjectionObjectParameters,
  type ToolLibraryProjectionObjectParameters,
  type ToolLibraryProjectionParameters,
} from './projection-descriptor-internal.js';
import { buildGeneratedToolSearchRuntimeModuleSource } from './search-ranking.js';
import {
  buildToolLibraryProjectionModuleImportSpecifier,
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
} from './projection-modules.js';

export const TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION =
  'geulbat-tool-library-projection-v10';

export function buildToolLibraryProjectionImportableModules(args: {
  importSpecifier: string;
  tools: readonly ToolLibraryProjectionGeneratedTool[];
}): ToolLibraryProjectionImportableModule[] {
  return [
    {
      specifier: args.importSpecifier,
      module: TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
      role: 'index',
    },
    {
      specifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: 'catalog.js',
      }),
      module: 'catalog.js',
      role: 'catalog',
    },
    {
      specifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: 'search.js',
      }),
      module: 'search.js',
      role: 'search',
    },
    {
      specifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
      }),
      module: TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
      role: 'search_runtime',
    },
    {
      specifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
      }),
      module: TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
      role: 'manifest',
    },
    {
      specifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: 'index.d.ts',
      }),
      module: 'index.d.ts',
      role: 'index_declaration',
    },
    ...args.tools.flatMap((tool) => [
      {
        specifier: tool.signatureImportSpecifier,
        module: tool.signatureModule,
        role: 'signature' as const,
      },
      {
        specifier: tool.signatureDeclarationImportSpecifier,
        module: tool.signatureDeclarationModule,
        role: 'signature_declaration' as const,
      },
      {
        specifier: tool.wrapperImportSpecifier,
        module: tool.wrapperModule,
        role: 'wrapper' as const,
      },
      {
        specifier: tool.wrapperDeclarationImportSpecifier,
        module: tool.wrapperDeclarationModule,
        role: 'wrapper_declaration' as const,
      },
    ]),
  ];
}

export function buildToolLibraryProjectionFiles(args: {
  projectionManifest: ToolLibraryProjectionManifest;
  tools: readonly ToolLibraryProjectionGeneratedTool[];
}): ToolLibraryProjectionFile[] {
  const wrapperFiles = args.tools.map((tool) => ({
    path: tool.wrapperModule,
    role: 'wrapper' as const,
    content: buildWrapperModule(tool),
  }));
  const wrapperDeclarationFiles = args.tools.map((tool) => ({
    path: tool.wrapperDeclarationModule,
    role: 'declaration' as const,
    content: buildWrapperDeclarationModule(tool),
  }));
  const signatureFiles = args.tools.map((tool) => ({
    path: tool.signatureModule,
    role: 'signature' as const,
    content: buildSignatureModule(tool),
  }));
  const signatureDeclarationFiles = args.tools.map((tool) => ({
    path: tool.signatureDeclarationModule,
    role: 'declaration' as const,
    content: buildSignatureDeclarationModule(tool),
  }));
  return [
    {
      path: TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
      role: 'manifest',
      content: serializeToolLibraryProjectionManifestModule(
        args.projectionManifest,
      ),
    },
    {
      path: args.projectionManifest.catalogModule,
      role: 'catalog',
      content: buildCatalogModule({
        projectionHash: args.projectionManifest.sdkProjectionHash,
        tools: args.tools,
      }),
    },
    {
      path: args.projectionManifest.searchModule,
      role: 'search',
      content: buildSearchModule(),
    },
    {
      path: args.projectionManifest.searchRuntimeModule,
      role: 'search_runtime',
      content: buildGeneratedToolSearchRuntimeModuleSource(),
    },
    {
      path: TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
      role: 'index',
      content: buildIndexModule(args.tools),
    },
    {
      path: 'index.d.ts',
      role: 'declaration',
      content: buildIndexDeclarationModule(args.tools),
    },
    ...signatureFiles,
    ...signatureDeclarationFiles,
    ...wrapperFiles,
    ...wrapperDeclarationFiles,
  ];
}

function buildCatalogModule(args: {
  projectionHash: `sha256:${string}`;
  tools: readonly ToolLibraryProjectionGeneratedTool[];
}): string {
  const catalog = args.tools.map((tool) => ({
    publicName: tool.publicName,
    family: tool.family,
    summary: tool.summary,
    signatureRef: tool.signatureRef,
    signatureModule: tool.signatureModule,
    signatureImportSpecifier: tool.signatureImportSpecifier,
    signatureDeclarationModule: tool.signatureDeclarationModule,
    signatureDeclarationImportSpecifier:
      tool.signatureDeclarationImportSpecifier,
    wrapperModule: tool.wrapperModule,
    wrapperImportSpecifier: tool.wrapperImportSpecifier,
    wrapperDeclarationModule: tool.wrapperDeclarationModule,
    wrapperDeclarationImportSpecifier: tool.wrapperDeclarationImportSpecifier,
    sideEffectLevel: tool.sideEffectLevel,
    approvalClass: tool.approvalClass,
    mayMutateComputerFiles: tool.mayMutateComputerFiles,
    searchHints: tool.searchHints,
    tags: tool.tags,
    whenToUse: tool.whenToUse,
    notFor: tool.notFor,
  }));
  return [
    `export const sdkProjectionHash = ${JSON.stringify(args.projectionHash)};`,
    `export const catalog = ${stableStringify(catalog)};`,
    '',
  ].join('\n');
}

function buildIndexModule(
  tools: readonly ToolLibraryProjectionGeneratedTool[],
): string {
  return [
    'export { projectionManifest } from "./manifest.js";',
    'export { catalog, sdkProjectionHash } from "./catalog.js";',
    'export { searchTools } from "./search.js";',
    ...tools.flatMap((tool) => {
      const modulePath = `./${tool.wrapperModule}`;
      return [
        `export { signature as ${tool.signatureExportName} } from ${JSON.stringify(
          `./${tool.signatureModule}`,
        )};`,
        `export { ${tool.wrapperExportName} } from ${JSON.stringify(
          modulePath,
        )};`,
      ];
    }),
    '',
  ].join('\n');
}

function buildIndexDeclarationModule(
  tools: readonly ToolLibraryProjectionGeneratedTool[],
): string {
  return [
    'export declare const projectionManifest: unknown;',
    'export declare const sdkProjectionHash: `sha256:${string}`;',
    '',
    'export interface ToolLibraryCatalogCard {',
    '  readonly publicName: string;',
    '  readonly family: string;',
    '  readonly summary: string;',
    '  readonly signatureRef: string;',
    '  readonly signatureModule: string;',
    '  readonly signatureImportSpecifier: string;',
    '  readonly signatureDeclarationModule: string;',
    '  readonly signatureDeclarationImportSpecifier: string;',
    '  readonly wrapperModule: string;',
    '  readonly wrapperImportSpecifier: string;',
    '  readonly wrapperDeclarationModule: string;',
    '  readonly wrapperDeclarationImportSpecifier: string;',
    "  readonly sideEffectLevel: 'none' | 'read' | 'write' | 'destructive';",
    "  readonly approvalClass: 'approval_free' | 'approval_required';",
    '  readonly mayMutateComputerFiles: boolean;',
    '  readonly searchHints: readonly string[];',
    '  readonly tags: readonly string[];',
    '  readonly whenToUse: string;',
    '  readonly notFor: string;',
    '}',
    '',
    'export declare const catalog: readonly ToolLibraryCatalogCard[];',
    '',
    'export interface ToolLibrarySearchResult extends ToolLibraryCatalogCard {',
    '  readonly rank: number;',
    '  readonly score: number;',
    '}',
    '',
    'export declare function searchTools(',
    '  query: string,',
    '): ToolLibrarySearchResult[];',
    '',
    ...tools.flatMap((tool) => {
      const wrapperModulePath = `./${tool.wrapperModule}`;
      const signatureModulePath = `./${tool.signatureModule}`;
      return [
        `export { signature as ${tool.signatureExportName} } from ${JSON.stringify(
          signatureModulePath,
        )};`,
        `export { ${tool.wrapperExportName} } from ${JSON.stringify(
          wrapperModulePath,
        )};`,
        `export type { ${tool.argsTypeName} } from ${JSON.stringify(
          wrapperModulePath,
        )};`,
      ];
    }),
    '',
  ].join('\n');
}

function buildSearchModule(): string {
  return [
    'import { searchRankedToolCatalog } from "./search-runtime.js";',
    'import { catalog } from "./catalog.js";',
    '',
    'export function searchTools(query) {',
    '  return searchRankedToolCatalog(query, catalog);',
    '}',
    '',
  ].join('\n');
}

function buildSignatureModule(
  tool: ToolLibraryProjectionGeneratedTool,
): string {
  const signature: ToolLibraryProjectionGeneratedSignature = {
    publicName: tool.publicName,
    signatureRef: tool.signatureRef,
    signatureModule: tool.signatureModule,
    signatureImportSpecifier: tool.signatureImportSpecifier,
    signatureDeclarationModule: tool.signatureDeclarationModule,
    signatureDeclarationImportSpecifier:
      tool.signatureDeclarationImportSpecifier,
    signatureExportName: tool.signatureExportName,
    summary: tool.summary,
    wrapperModule: tool.wrapperModule,
    wrapperImportSpecifier: tool.wrapperImportSpecifier,
    wrapperDeclarationModule: tool.wrapperDeclarationModule,
    wrapperDeclarationImportSpecifier: tool.wrapperDeclarationImportSpecifier,
    wrapperExportName: tool.wrapperExportName,
    invocationExample: buildInvocationExample(tool),
    argsTypeName: tool.argsTypeName,
    sideEffectLevel: tool.sideEffectLevel,
    approvalClass: tool.approvalClass,
    mayMutateComputerFiles: tool.mayMutateComputerFiles,
    family: tool.family,
    searchHints: tool.searchHints,
    tags: tool.tags,
    whenToUse: tool.whenToUse,
    notFor: tool.notFor,
    parameters: tool.parameters,
  };
  return [`export const signature = ${stableStringify(signature)};`, ''].join(
    '\n',
  );
}

function buildSignatureDeclarationModule(
  tool: ToolLibraryProjectionGeneratedTool,
): string {
  const wrapperSpecifier = `../${tool.wrapperModule}`;
  return [
    `export type { ${tool.argsTypeName} } from ${JSON.stringify(
      wrapperSpecifier,
    )};`,
    '',
    `export interface ${toPascalCase(tool.publicName)}ToolSignature {`,
    `  readonly publicName: ${JSON.stringify(tool.publicName)};`,
    `  readonly signatureRef: ${JSON.stringify(tool.signatureRef)};`,
    `  readonly signatureModule: ${JSON.stringify(tool.signatureModule)};`,
    `  readonly signatureImportSpecifier: ${JSON.stringify(
      tool.signatureImportSpecifier,
    )};`,
    `  readonly signatureDeclarationModule: ${JSON.stringify(
      tool.signatureDeclarationModule,
    )};`,
    `  readonly signatureDeclarationImportSpecifier: ${JSON.stringify(
      tool.signatureDeclarationImportSpecifier,
    )};`,
    `  readonly signatureExportName: ${JSON.stringify(
      tool.signatureExportName,
    )};`,
    `  readonly summary: ${JSON.stringify(tool.summary)};`,
    `  readonly wrapperModule: ${JSON.stringify(tool.wrapperModule)};`,
    `  readonly wrapperImportSpecifier: ${JSON.stringify(
      tool.wrapperImportSpecifier,
    )};`,
    `  readonly wrapperDeclarationModule: ${JSON.stringify(
      tool.wrapperDeclarationModule,
    )};`,
    `  readonly wrapperDeclarationImportSpecifier: ${JSON.stringify(
      tool.wrapperDeclarationImportSpecifier,
    )};`,
    `  readonly wrapperExportName: ${JSON.stringify(tool.wrapperExportName)};`,
    `  readonly invocationExample: ${JSON.stringify(
      buildInvocationExample(tool),
    )};`,
    `  readonly argsTypeName: ${JSON.stringify(tool.argsTypeName)};`,
    `  readonly args: ${tool.argsTypeName};`,
    `  readonly sideEffectLevel: ${JSON.stringify(tool.sideEffectLevel)};`,
    `  readonly approvalClass: ${JSON.stringify(tool.approvalClass)};`,
    `  readonly mayMutateComputerFiles: ${JSON.stringify(
      tool.mayMutateComputerFiles,
    )};`,
    `  readonly family: ${JSON.stringify(tool.family)};`,
    '  readonly searchHints: readonly string[];',
    '  readonly tags: readonly string[];',
    `  readonly whenToUse: ${JSON.stringify(tool.whenToUse)};`,
    `  readonly notFor: ${JSON.stringify(tool.notFor)};`,
    '  readonly parameters: unknown;',
    '}',
    '',
    `export declare const signature: Omit<${toPascalCase(
      tool.publicName,
    )}ToolSignature, "args">;`,
    '',
  ].join('\n');
}

function buildInvocationExample(
  tool: ToolLibraryProjectionGeneratedTool,
): string {
  return [
    'if (!geulbat.help().callbacks.enabled) throw new Error("PTC callbacks unavailable");',
    `const { ${tool.wrapperExportName} } = require(${JSON.stringify(
      tool.wrapperImportSpecifier,
    )});`,
    `return await ${tool.wrapperExportName}({ /* arguments matching parameters */ });`,
  ].join('\n');
}

function buildWrapperModule(tool: ToolLibraryProjectionGeneratedTool): string {
  return [
    'let callTool;',
    '',
    'export function bindGeulbatRuntime(geulbat) {',
    '  if (callTool !== undefined) {',
    '    throw new Error("Generated tool wrapper runtime is already bound");',
    '  }',
    '  if (geulbat === null || typeof geulbat !== "object" || typeof geulbat.callTool !== "function") {',
    '    throw new Error("Generated tool wrapper requires the geulbat callback runtime");',
    '  }',
    '  callTool = geulbat.callTool.bind(geulbat);',
    '}',
    '',
    `export async function ${tool.wrapperExportName}(args) {`,
    '  if (callTool === undefined) {',
    '    throw new Error("Generated tool wrapper runtime is not bound");',
    '  }',
    `  const result = await callTool(${JSON.stringify(
      tool.callbackName,
    )}, args);`,
    '  return normalizeToolResult(result);',
    '}',
    '',
    'function normalizeToolResult(result) {',
    '  if (isOffloadedToolResult(result)) {',
    '    return {',
    '      kind: "offloaded",',
    '      outputRef: result.outputRef,',
    '      ...(typeof result.summary === "string"',
    '        ? { summary: result.summary }',
    '        : {}),',
    '      ...(typeof result.fullOutputBytes === "number"',
    '        ? { fullOutputBytes: result.fullOutputBytes }',
    '        : {}),',
    '      ...(typeof result.fullOutputChars === "number"',
    '        ? { fullOutputChars: result.fullOutputChars }',
    '        : {}),',
    '      raw: result,',
    '    };',
    '  }',
    '  return { kind: "inline", value: result };',
    '}',
    '',
    'function isOffloadedToolResult(value) {',
    '  return (',
    '    typeof value === "object" &&',
    '    value !== null &&',
    '    "offloaded" in value &&',
    '    value.offloaded === true &&',
    '    "outputRef" in value &&',
    '    typeof value.outputRef === "string"',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildWrapperDeclarationModule(
  tool: ToolLibraryProjectionGeneratedTool,
): string {
  return [
    'export interface GeulbatInlineToolResult {',
    '  kind: "inline";',
    '  value: unknown;',
    '}',
    '',
    'export interface GeulbatOffloadedToolResult {',
    '  kind: "offloaded";',
    '  outputRef: string;',
    '  summary?: string;',
    '  fullOutputBytes?: number;',
    '  fullOutputChars?: number;',
    '  raw: Readonly<Record<string, unknown>>;',
    '}',
    '',
    'export type GeulbatToolResult =',
    '  | GeulbatInlineToolResult',
    '  | GeulbatOffloadedToolResult;',
    '',
    buildArgsTypeDeclaration(tool),
    '',
    `export declare function ${tool.wrapperExportName}(`,
    `  args: ${tool.argsTypeName},`,
    '): Promise<GeulbatToolResult>;',
    '',
  ].join('\n');
}

function buildArgsTypeDeclaration(
  tool: ToolLibraryProjectionGeneratedTool,
): string {
  if (isToolLibraryProjectionObjectParameters(tool.parameters)) {
    return `export interface ${tool.argsTypeName} ${objectParametersToTsInterfaceBody(
      tool.parameters,
    )}`;
  }
  return `export type ${tool.argsTypeName} = ${toolParametersToTsType(
    tool.parameters,
  )};`;
}

function toolParametersToTsType(
  parameters: ToolLibraryProjectionParameters,
): string {
  if (isToolLibraryProjectionObjectParameters(parameters)) {
    return objectParametersToTsInterfaceBody(parameters);
  }
  if ('oneOf' in parameters) {
    return branchParametersToTsType(parameters.oneOf);
  }
  return branchParametersToTsType(parameters.anyOf);
}

function branchParametersToTsType(
  branches: readonly ToolLibraryProjectionObjectParameters[],
): string {
  return branches.map(objectParametersToTsInterfaceBody).join(' | ');
}

function objectParametersToTsInterfaceBody(
  parameters: ToolLibraryProjectionObjectParameters,
): string {
  const required = new Set(parameters.required);
  const propertyLines = Object.entries(parameters.properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => {
      const optional = required.has(name) ? '' : '?';
      return `  ${JSON.stringify(name)}${optional}: ${propertySchemaToTsType(
        schema,
      )};`;
    });
  if (propertyLines.length === 0) {
    return '{\n}';
  }
  return ['{', ...propertyLines, '}'].join('\n');
}

function propertySchemaToTsType(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return 'unknown';
  }
  const enumValue: unknown = Reflect.get(schema, 'enum');
  if (Array.isArray(enumValue)) {
    return enumValue.map(literalToTsType).join(' | ');
  }
  if (Reflect.has(schema, 'const')) {
    const constantValue: unknown = Reflect.get(schema, 'const');
    return literalToTsType(constantValue);
  }
  const typeValue: unknown = Reflect.get(schema, 'type');
  switch (typeValue) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'unknown';
  }
}

function literalToTsType(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  return 'unknown';
}
