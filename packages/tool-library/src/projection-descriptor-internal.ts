export const TOOL_LIBRARY_PROJECTION_SIDE_EFFECT_LEVELS = [
  'none',
  'read',
  'write',
  'destructive',
] as const;

export type ToolLibraryProjectionSideEffectLevel =
  (typeof TOOL_LIBRARY_PROJECTION_SIDE_EFFECT_LEVELS)[number];

export type ToolLibraryProjectionApprovalClass =
  | 'approval_free'
  | 'approval_required';

export type ToolLibraryProjectionCatalogSearchFamily =
  | 'agent'
  | 'browser'
  | 'command'
  | 'catalog'
  | 'file'
  | 'memory'
  | 'network'
  | 'planning'
  | 'presentation'
  | 'ptc'
  | 'tool_output';

export interface ToolLibraryProjectionObjectParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

interface ToolLibraryProjectionOneOfParameters {
  oneOf: ToolLibraryProjectionObjectParameters[];
}

interface ToolLibraryProjectionAnyOfParameters {
  anyOf: ToolLibraryProjectionObjectParameters[];
}

export type ToolLibraryProjectionParameters =
  | ToolLibraryProjectionObjectParameters
  | ToolLibraryProjectionOneOfParameters
  | ToolLibraryProjectionAnyOfParameters;

export function isToolLibraryProjectionObjectParameters(
  parameters: ToolLibraryProjectionParameters,
): parameters is ToolLibraryProjectionObjectParameters {
  return !('oneOf' in parameters) && !('anyOf' in parameters);
}
