import { isRecord } from '../runtime-json.js';
import type { ToolCatalogSearchMetadata, ToolExposure } from './types.js';
import type {
  RegisteredToolLike,
  ToolDefinition,
  ToolExecutionHandle,
  ToolMeta,
  ToolObjectParameters,
  ToolRegistrySnapshot,
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

type NormalizedTool = RegisteredToolLike & { exposure: ToolExposure };

interface RegistryEntry {
  tool: NormalizedTool;
  executionHandle: ToolExecutionHandle;
  meta: ToolMeta;
}

function resolveToolExposure(tool: RegisteredToolLike): ToolExposure {
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

function cloneTool(tool: RegisteredToolLike): NormalizedTool {
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
    ...(tool.abortSettlement ? { abortSettlement: tool.abortSettlement } : {}),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    requiresApproval: tool.requiresApproval,
    ...(tool.approvalClass === undefined
      ? {}
      : { approvalClass: tool.approvalClass }),
    exposure: resolveToolExposure(tool),
    ...(tool.recoveryStrategy
      ? { recoveryStrategy: tool.recoveryStrategy }
      : {}),
    ...(tool.resultProjection
      ? { resultProjection: { ...tool.resultProjection } }
      : {}),
    ...(tool.streamsArgsDelta === true ? { streamsArgsDelta: true } : {}),
    ...(tool.endsTurnAfterSuccess === true
      ? { endsTurnAfterSuccess: true }
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

function createRegistryEntry(tool: RegisteredToolLike): RegistryEntry {
  const normalizedTool = cloneTool(tool);
  const abortSettlement =
    normalizedTool.abortSettlement ??
    (normalizedTool.sideEffectLevel === 'write' ||
    normalizedTool.sideEffectLevel === 'destructive'
      ? 'await_execution'
      : 'immediate');
  const executionHandle: ToolExecutionHandle = Object.freeze({
    ...(normalizedTool.timeoutMs === undefined
      ? {}
      : { timeoutMs: normalizedTool.timeoutMs }),
    requiresApproval: normalizedTool.requiresApproval,
    abortSettlement,
    parseArgs: (raw) => normalizedTool.parseArgs(raw),
    executeParsed: (args, ctx) => normalizedTool.executeParsed(args, ctx),
  });
  const meta: ToolMeta = Object.freeze({
    sideEffectLevel: normalizedTool.sideEffectLevel,
    mayMutateComputerFiles: normalizedTool.mayMutateComputerFiles,
    ...(normalizedTool.parallelBatchKind
      ? { parallelBatchKind: normalizedTool.parallelBatchKind }
      : {}),
    ...(normalizedTool.timeoutMs === undefined
      ? {}
      : { timeoutMs: normalizedTool.timeoutMs }),
    requiresApproval: normalizedTool.requiresApproval,
    ...(normalizedTool.approvalClass === undefined
      ? {}
      : { approvalClass: normalizedTool.approvalClass }),
    exposure: Object.freeze({ ...normalizedTool.exposure }),
    ...(normalizedTool.recoveryStrategy
      ? { recoveryStrategy: normalizedTool.recoveryStrategy }
      : {}),
    ...(normalizedTool.resultProjection
      ? {
          resultProjection: Object.freeze({
            ...normalizedTool.resultProjection,
          }),
        }
      : {}),
    ...(normalizedTool.streamsArgsDelta === true
      ? { streamsArgsDelta: true }
      : {}),
    ...(normalizedTool.endsTurnAfterSuccess === true
      ? { endsTurnAfterSuccess: true }
      : {}),
  });
  return { tool: normalizedTool, executionHandle, meta };
}

function isProviderStrictCompatible(tool: RegisteredToolLike): boolean {
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

function createRegistrySnapshot(
  tools: ReadonlyMap<string, RegistryEntry>,
  captureSnapshot: () => ToolRegistrySnapshot,
): ToolRegistrySnapshot {
  const snapshot: ToolRegistrySnapshot = {
    captureSnapshot,

    getTool(name) {
      const entry = tools.get(name);
      return entry ? cloneTool(entry.tool) : undefined;
    },

    getToolExecutionHandle(name) {
      return tools.get(name)?.executionHandle;
    },

    getToolMeta(name) {
      return tools.get(name)?.meta ?? null;
    },

    getAllRegisteredToolNames() {
      return [...tools.keys()].sort();
    },

    buildToolDefinitions(options) {
      const names = [...(options?.names ?? tools.keys())].sort();
      const definitions: ToolDefinition[] = [];

      for (const name of names) {
        const entry = tools.get(name);
        if (!entry) {
          continue;
        }
        const { tool } = entry;
        definitions.push({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: cloneToolParameters(tool.parameters),
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
  return Object.freeze(snapshot);
}

export function createToolRegistryStore(options?: {
  builtins?: readonly RegisteredToolLike[];
}): ToolRegistryStore {
  const tools = new Map<string, RegistryEntry>();

  for (const tool of options?.builtins ?? []) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, createRegistryEntry(tool));
    }
  }

  const captureSnapshot = (): ToolRegistrySnapshot =>
    createRegistrySnapshot(new Map(tools), captureSnapshot);
  const liveRegistry = createRegistrySnapshot(tools, captureSnapshot);

  return {
    ...liveRegistry,

    registerTool(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, createRegistryEntry(tool));
    },

    unregisterTool(name) {
      return tools.delete(name);
    },
  };
}

export type {
  ToolExecutionRegistry,
  ToolMetaReader,
  ToolRegistrySnapshot,
  ToolRegistryStore,
  ToolResolver,
  ToolRuntimeRegistry,
} from './tool-registry-model.js';
