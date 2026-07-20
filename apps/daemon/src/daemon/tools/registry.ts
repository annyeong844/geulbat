import { isRecord } from '../runtime-json.js';
import type {
  AnyTool,
  ToolCatalogSearchMetadata,
  ToolExposure,
} from './types.js';
import type {
  ToolDefinition,
  ToolObjectParameters,
  ToolRegistryStore,
} from './tool-registry-model.js';
import {
  cloneToolParameters,
  isToolObjectParameters,
} from './tool-registry-model.js';

function cloneToolCatalogSearchMetadata(
  metadata: ToolCatalogSearchMetadata,
): ToolCatalogSearchMetadata {
  return {
    ...metadata,
    searchHints: [...metadata.searchHints],
    tags: [...metadata.tags],
  };
}

type NormalizedTool = AnyTool & { exposure: ToolExposure };

function resolveToolExposure(tool: AnyTool): ToolExposure {
  const exposure = tool.exposure ?? {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    effectClass: 'exclusive',
  };
  if (exposure.directOnly && (exposure.sdkVisible || exposure.inCellCallable)) {
    throw new Error(
      `Tool exposure conflict for ${tool.name}: direct-only tools cannot be SDK-callable`,
    );
  }
  if (exposure.inCellCallable && !exposure.sdkVisible) {
    throw new Error(
      `Tool exposure conflict for ${tool.name}: in-cell tools require an SDK projection`,
    );
  }
  if (
    !exposure.directHot &&
    (!exposure.sdkVisible || !exposure.inCellCallable || exposure.directOnly)
  ) {
    throw new Error(
      `Tool exposure conflict for ${tool.name}: non-hot tools require complete SDK reachability`,
    );
  }
  return { ...exposure };
}

function cloneTool(tool: AnyTool): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: cloneToolParameters(tool.parameters),
    strict: tool.strict,
    sideEffectLevel: tool.sideEffectLevel,
    mayMutateComputerFiles: tool.mayMutateComputerFiles,
    ...(tool.parallelBatchKind
      ? { parallelBatchKind: tool.parallelBatchKind }
      : {}),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    requiresApproval: tool.requiresApproval,
    exposure: resolveToolExposure(tool),
    ...(tool.recoveryStrategy
      ? { recoveryStrategy: tool.recoveryStrategy }
      : {}),
    ...(tool.catalogSearchMetadata
      ? {
          catalogSearchMetadata: cloneToolCatalogSearchMetadata(
            tool.catalogSearchMetadata,
          ),
        }
      : {}),
    parseArgs: (raw) => tool.parseArgs(raw),
    executeParsed: (args, ctx) => tool.executeParsed(args, ctx),
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
  return isPropertySchemaStrictCompatible(parameters);
}

function isPropertySchemaStrictCompatible(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (schema.type === 'array') {
    return isPropertySchemaStrictCompatible(schema.items);
  }
  if (schema.type !== 'object') {
    return (
      schema.type === 'string' ||
      schema.type === 'number' ||
      schema.type === 'integer' ||
      schema.type === 'boolean'
    );
  }
  if (
    !isRecord(schema.properties) ||
    !Array.isArray(schema.required) ||
    schema.additionalProperties !== false
  ) {
    return false;
  }
  const required = new Set(
    schema.required.filter((name): name is string => typeof name === 'string'),
  );
  return Object.entries(schema.properties).every(
    ([name, property]) =>
      required.has(name) && isPropertySchemaStrictCompatible(property),
  );
}

export function createToolRegistryStore(options?: {
  builtins?: readonly AnyTool[];
}): ToolRegistryStore {
  const tools = new Map<string, NormalizedTool>();

  for (const tool of options?.builtins ?? []) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, cloneTool(tool));
    }
  }

  return {
    registerTool(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, cloneTool(tool));
    },

    unregisterTool(name) {
      return tools.delete(name);
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
        mayMutateComputerFiles: tool.mayMutateComputerFiles,
        ...(tool.parallelBatchKind
          ? { parallelBatchKind: tool.parallelBatchKind }
          : {}),
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        requiresApproval: tool.requiresApproval,
        exposure: { ...tool.exposure },
        ...(tool.recoveryStrategy
          ? { recoveryStrategy: tool.recoveryStrategy }
          : {}),
        ...(tool.streamsArgsDelta === true ? { streamsArgsDelta: true } : {}),
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
