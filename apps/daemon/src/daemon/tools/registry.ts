import type { AnyTool } from './types.js';
import type {
  ToolDefinition,
  ToolObjectParameters,
  ToolParameters,
  ToolRegistryStore,
} from './tool-registry-model.js';
import { isToolObjectParameters } from './tool-registry-model.js';

function cloneToolParameters(parameters: ToolParameters): ToolParameters {
  return JSON.parse(JSON.stringify(parameters)) as ToolParameters;
}

function cloneTool(tool: AnyTool): AnyTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: cloneToolParameters(tool.parameters),
    strict: tool.strict,
    sideEffectLevel: tool.sideEffectLevel,
    mayMutateWorkspaceFiles: tool.mayMutateWorkspaceFiles,
    ...(tool.parallelBatchKind
      ? { parallelBatchKind: tool.parallelBatchKind }
      : {}),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    requiresApproval: tool.requiresApproval,
    parseArgs: tool.parseArgs,
    executeParsed: tool.executeParsed,
  };
}

function isProviderStrictCompatible(tool: AnyTool): boolean {
  if (!isToolObjectParameters(tool.parameters)) {
    return false;
  }
  return isObjectSchemaStrictCompatible(tool.parameters);
}

function isObjectSchemaStrictCompatible(
  parameters: ToolObjectParameters,
): boolean {
  const propertyNames = Object.keys(parameters.properties);
  if (propertyNames.length === 0) {
    return true;
  }
  const required = new Set(parameters.required);
  return propertyNames.every((name) => required.has(name));
}

export function createToolRegistryStore(options?: {
  builtins?: readonly AnyTool[];
}): ToolRegistryStore {
  const tools = new Map<string, AnyTool>();

  for (const tool of options?.builtins ?? []) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, tool);
    }
  }

  return {
    registerTool(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },

    getTool(name) {
      const tool = tools.get(name);
      return tool ? cloneTool(tool) : undefined;
    },

    getToolMeta(name) {
      const tool = tools.get(name);
      if (!tool) {
        return null;
      }
      return {
        sideEffectLevel: tool.sideEffectLevel,
        mayMutateWorkspaceFiles: tool.mayMutateWorkspaceFiles,
        ...(tool.parallelBatchKind
          ? { parallelBatchKind: tool.parallelBatchKind }
          : {}),
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        requiresApproval: tool.requiresApproval,
      };
    },

    getAllRegisteredToolNames() {
      return [...tools.keys()].sort();
    },

    buildToolDefinitions(options) {
      const names = options?.names ?? [...tools.keys()].sort();
      const definitions: ToolDefinition[] = [];

      for (const name of names.slice().sort()) {
        const tool = tools.get(name);
        if (!tool) {
          continue;
        }
        definitions.push({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // Provider strict mode currently rejects object schemas that leave
          // any declared property out of `required`. Keep tool-local strict
          // intent, but only publish strict=true when the wire schema is
          // compatible with that provider contract.
          strict: tool.strict && isProviderStrictCompatible(tool),
        });
      }

      return definitions;
    },
  };
}

export type {
  ToolExecutionRegistry,
  ToolMetaReader,
  ToolRegistryStore,
  ToolResolver,
  ToolRuntimeRegistry,
} from './tool-registry-model.js';
