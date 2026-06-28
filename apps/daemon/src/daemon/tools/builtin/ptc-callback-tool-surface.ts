import {
  PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntimeSdkHelpTool,
  type PtcExecuteCodeRuntimeSdkHelpToolParameters,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { ToolDefinition, ToolMeta } from '../types.js';
import type { ToolRuntimeRegistry } from '../tool-registry-model.js';

const AGENT_ORCHESTRATION_TOOL_PREFIX = 'agent_';

export interface PtcExecuteCodeCallbackToolSurface {
  callbackTools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
  allows(toolName: string): boolean;
}

export function resolvePtcExecuteCodeCallbackToolSurface(args: {
  registry: ToolRuntimeRegistry;
  allowedToolNames?: readonly string[];
}): PtcExecuteCodeCallbackToolSurface {
  const definitions = args.registry.buildToolDefinitions(
    args.allowedToolNames !== undefined
      ? { names: [...new Set(args.allowedToolNames)] }
      : {},
  );
  const callableToolNames = new Set<string>();
  const callbackTools: PtcExecuteCodeRuntimeSdkHelpTool[] = [];

  for (const definition of definitions) {
    const meta = args.registry.getToolMeta(definition.name);
    if (
      meta === null ||
      !isPtcExecuteCodeCallbackToolMetaAllowed(definition.name, meta)
    ) {
      continue;
    }

    callableToolNames.add(definition.name);
    callbackTools.push(toCallbackHelpTool(definition));
  }

  return Object.freeze({
    callbackTools: Object.freeze(callbackTools),
    allows(toolName: string): boolean {
      return callableToolNames.has(toolName);
    },
  });
}

export function isPtcExecuteCodeCallbackToolMetaAllowed(
  toolName: string,
  meta: Partial<ToolMeta>,
): boolean {
  return (
    toolName !== PTC_EXECUTE_CODE_TOOL_NAME &&
    toolName !== PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME &&
    toolName !== PTC_EXECUTE_CODE_WAIT_TOOL_NAME &&
    !toolName.startsWith(AGENT_ORCHESTRATION_TOOL_PREFIX) &&
    meta.requiresApproval === false &&
    meta.sideEffectLevel === 'read' &&
    meta.mayMutateWorkspaceFiles === false
  );
}

function toCallbackHelpTool(
  definition: ToolDefinition,
): PtcExecuteCodeRuntimeSdkHelpTool {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    parameters: cloneToolParameters(definition.parameters),
  });
}

function cloneToolParameters(
  parameters: PtcExecuteCodeRuntimeSdkHelpToolParameters,
): PtcExecuteCodeRuntimeSdkHelpToolParameters {
  return JSON.parse(
    JSON.stringify(parameters),
  ) as PtcExecuteCodeRuntimeSdkHelpToolParameters;
}
