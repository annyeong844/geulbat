import type { ToolLibraryProjectionGeneratedTool } from '@geulbat/tool-library/projection-descriptor';
import { buildToolSignatureRef } from '@geulbat/tool-library/projection-signature';
import { summarizeToolDescription } from '@geulbat/tool-library/search-ranking';
import {
  toIdentifier,
  toKebabFileStem,
  toPascalCase,
} from '@geulbat/shared-utils/identifier-naming';
import { buildToolLibraryProjectionModuleImportSpecifier } from './tool-library-projection-path.js';
import {
  cloneToolParameters,
  type ToolRegistryStore,
} from './tool-registry-model.js';

interface ResolveToolLibraryProjectionToolsArgs {
  registry: Pick<ToolRegistryStore, 'getAllRegisteredToolNames' | 'getTool'>;
  allowedRegistryNames: readonly string[];
  importSpecifier: string;
}

export function resolveToolLibraryProjectionTools(
  args: ResolveToolLibraryProjectionToolsArgs,
): ToolLibraryProjectionGeneratedTool[] {
  const registeredNames = new Set(args.registry.getAllRegisteredToolNames());
  const names = uniqueSorted(args.allowedRegistryNames);
  const missing = names.filter((name) => !registeredNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Tool library projection includes unknown tools: ${missing.join(', ')}`,
    );
  }

  return names.map((name) => {
    const tool = args.registry.getTool(name);
    if (!tool) {
      throw new Error(`Tool library projection tool disappeared: ${name}`);
    }
    const metadata = tool.catalogSearchMetadata;
    const fileStem = toKebabFileStem(tool.name);
    const wrapperExportName = toIdentifier(tool.name, 'tool');
    const summary =
      metadata?.summary ?? summarizeToolDescription(tool.description);
    const signatureModule = `signatures/${fileStem}.js`;
    const signatureDeclarationModule = `signatures/${fileStem}.d.ts`;
    const wrapperModule =
      metadata?.family === 'file'
        ? `files/${wrapperExportName}.js`
        : `tools/${fileStem}.js`;
    const wrapperDeclarationModule = wrapperModule.replace(/\.js$/u, '.d.ts');
    return {
      publicName: tool.name,
      registryName: tool.name,
      callbackName: tool.name,
      summary,
      signatureRef: buildToolSignatureRef(tool.name),
      signatureModule,
      signatureImportSpecifier: buildToolLibraryProjectionModuleImportSpecifier(
        {
          importSpecifier: args.importSpecifier,
          module: signatureModule,
        },
      ),
      signatureDeclarationModule,
      signatureDeclarationImportSpecifier:
        buildToolLibraryProjectionModuleImportSpecifier({
          importSpecifier: args.importSpecifier,
          module: signatureDeclarationModule,
        }),
      signatureExportName: `${wrapperExportName}Signature`,
      wrapperModule,
      wrapperImportSpecifier: buildToolLibraryProjectionModuleImportSpecifier({
        importSpecifier: args.importSpecifier,
        module: wrapperModule,
      }),
      wrapperDeclarationModule,
      wrapperDeclarationImportSpecifier:
        buildToolLibraryProjectionModuleImportSpecifier({
          importSpecifier: args.importSpecifier,
          module: wrapperDeclarationModule,
        }),
      wrapperExportName,
      argsTypeName: `${toPascalCase(tool.name)}Args`,
      sideEffectLevel: tool.sideEffectLevel,
      approvalClass: tool.requiresApproval
        ? 'approval_required'
        : 'approval_free',
      mayMutateComputerFiles: tool.mayMutateComputerFiles,
      family: metadata?.family ?? 'catalog',
      searchHints: [...(metadata?.searchHints ?? [])].sort(),
      tags: [...(metadata?.tags ?? [tool.sideEffectLevel])].sort(),
      whenToUse: metadata?.whenToUse ?? summary,
      notFor:
        metadata?.notFor ??
        'Unavailable behavior must be handled by another registered tool.',
      parameters: cloneToolParameters(tool.parameters),
    };
  });
}

export function hashableToolLibraryProjectionTool(
  tool: ToolLibraryProjectionGeneratedTool,
): object {
  return toToolLibraryProjectionTool(tool);
}

function toToolLibraryProjectionTool(
  tool: ToolLibraryProjectionGeneratedTool,
): ToolLibraryProjectionGeneratedTool {
  return {
    publicName: tool.publicName,
    registryName: tool.registryName,
    callbackName: tool.callbackName,
    summary: tool.summary,
    signatureRef: tool.signatureRef,
    signatureModule: tool.signatureModule,
    signatureImportSpecifier: tool.signatureImportSpecifier,
    signatureDeclarationModule: tool.signatureDeclarationModule,
    signatureDeclarationImportSpecifier:
      tool.signatureDeclarationImportSpecifier,
    signatureExportName: tool.signatureExportName,
    wrapperModule: tool.wrapperModule,
    wrapperImportSpecifier: tool.wrapperImportSpecifier,
    wrapperDeclarationModule: tool.wrapperDeclarationModule,
    wrapperDeclarationImportSpecifier: tool.wrapperDeclarationImportSpecifier,
    wrapperExportName: tool.wrapperExportName,
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
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
