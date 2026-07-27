import type { ToolDefinition } from '../tools/types.js';
import type { ToolRegistryStore } from '../tools/tool-registry-model.js';

const ROOT_DIRECT_TOOL_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  'agent_retry',
  'agent_send_input',
  'agent_set_priority',
  'agent_spawn',
  'agent_stop',
  'agent_wait',
  'apply_patch',
  'ask_user',
  'exec',
  'exec_command',
  'inspect_git',
  'list_files',
  'manage_files',
  'propose_plan',
  'read_file',
  'read_tool_output',
  'search_files',
  'search_memory_index',
  'tool_search',
  'update_goal',
  'update_plan',
  'wait',
  'write_file',
  'write_stdin',
]);

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
          ROOT_DIRECT_TOOL_NAME_ALLOWLIST.has(definition.name) &&
          registry.getToolMeta(definition.name)?.exposure.directHot === true,
      );
    },
  };
}
