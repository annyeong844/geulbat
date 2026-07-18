import type { ToolDefinition } from '../tools/types.js';
import type { ToolRegistryStore } from '../tools/tool-registry-model.js';

interface BuildAgentLoopToolDefinitionsArgs {
  directRegistryNames?: readonly string[];
}

export interface AgentLoopToolDefinitionPort {
  buildToolDefinitions(
    args: BuildAgentLoopToolDefinitionsArgs,
  ): readonly ToolDefinition[];
}

export function createAgentLoopToolDefinitionPort(
  registry: Pick<ToolRegistryStore, 'buildToolDefinitions' | 'getToolMeta'>,
): AgentLoopToolDefinitionPort {
  return {
    buildToolDefinitions(args) {
      const definitions =
        args.directRegistryNames === undefined
          ? registry.buildToolDefinitions()
          : registry.buildToolDefinitions({
              names: [...args.directRegistryNames],
            });
      if (args.directRegistryNames !== undefined) {
        return definitions;
      }
      return definitions.filter(
        (definition) =>
          registry.getToolMeta(definition.name)?.exposure.directHot === true,
      );
    },
  };
}
