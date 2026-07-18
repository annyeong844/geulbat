import type {
  ToolLibraryProjectionApprovalClass,
  ToolLibraryProjectionCatalogSearchFamily,
  ToolLibraryProjectionParameters,
  ToolLibraryProjectionSideEffectLevel,
} from './projection-descriptor-internal.js';

export interface ToolLibraryProjectionGeneratedTool {
  publicName: string;
  registryName: string;
  callbackName: string;
  summary: string;
  signatureRef: string;
  signatureModule: string;
  signatureImportSpecifier: string;
  signatureDeclarationModule: string;
  signatureDeclarationImportSpecifier: string;
  signatureExportName: string;
  wrapperModule: string;
  wrapperImportSpecifier: string;
  wrapperDeclarationModule: string;
  wrapperDeclarationImportSpecifier: string;
  wrapperExportName: string;
  argsTypeName: string;
  sideEffectLevel: ToolLibraryProjectionSideEffectLevel;
  approvalClass: ToolLibraryProjectionApprovalClass;
  mayMutateComputerFiles: boolean;
  family: ToolLibraryProjectionCatalogSearchFamily;
  searchHints: readonly string[];
  tags: readonly string[];
  whenToUse: string;
  notFor: string;
  parameters: ToolLibraryProjectionParameters;
}

export interface ToolLibraryProjectionGeneratedSignature extends Omit<
  ToolLibraryProjectionGeneratedTool,
  'callbackName' | 'registryName'
> {
  invocationExample: string;
}

export interface ToolLibraryProjectionFile {
  path: string;
  role:
    | 'catalog'
    | 'declaration'
    | 'index'
    | 'manifest'
    | 'search'
    | 'search_runtime'
    | 'signature'
    | 'wrapper';
  content: string;
}
