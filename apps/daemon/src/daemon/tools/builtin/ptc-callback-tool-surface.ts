import {
  PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntimeSdkHelpTool,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { ToolDefinition, ToolMeta } from '../types.js';
import {
  cloneToolParameters,
  type ToolRuntimeRegistry,
} from '../tool-registry-model.js';

const AGENT_ORCHESTRATION_TOOL_PREFIX = 'agent_';

// The write-callback slice admits an explicit tool-name allowlist intersected
// with the write/mutate/approval meta invariant. Future write tools do not
// join this surface without their own named slice.
const PTC_EXECUTE_CODE_WRITE_CALLBACK_TOOL_ALLOWLIST: ReadonlySet<string> =
  new Set(['apply_patch', 'manage_files']);

export interface PtcExecuteCodeCallbackToolSurface {
  callbackTools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
  writeTierEnabled: boolean;
  allows(toolName: string): boolean;
  allowsWrite(toolName: string): boolean;
}

export function resolvePtcExecuteCodeCallbackToolSurface(args: {
  registry: ToolRuntimeRegistry;
  allowedRegistryNames?: readonly string[];
  writeCallbackEnabled?: boolean;
}): PtcExecuteCodeCallbackToolSurface {
  const definitions = args.registry.buildToolDefinitions(
    args.allowedRegistryNames !== undefined
      ? { names: [...new Set(args.allowedRegistryNames)] }
      : {},
  );
  const writeTierEnabled = args.writeCallbackEnabled === true;
  const callableToolNames = new Set<string>();
  const callableWriteToolNames = new Set<string>();
  const callbackTools: PtcExecuteCodeRuntimeSdkHelpTool[] = [];

  for (const definition of definitions) {
    const meta = args.registry.getToolMeta(definition.name);
    if (meta === null) {
      continue;
    }
    if (isPtcExecuteCodeCallbackToolMetaAllowed(definition.name, meta)) {
      callableToolNames.add(definition.name);
      callbackTools.push(toCallbackHelpTool(definition));
      continue;
    }
    if (
      writeTierEnabled &&
      isPtcExecuteCodeWriteCallbackToolMetaAllowed(definition.name, meta)
    ) {
      callableToolNames.add(definition.name);
      callableWriteToolNames.add(definition.name);
      callbackTools.push(toCallbackHelpTool(definition, { write: true }));
    }
  }

  return Object.freeze({
    callbackTools: Object.freeze(callbackTools),
    writeTierEnabled,
    allows(toolName: string): boolean {
      return callableToolNames.has(toolName);
    },
    allowsWrite(toolName: string): boolean {
      return callableWriteToolNames.has(toolName);
    },
  });
}

// PTC 콜백과 아티팩트 프레임(run.tool)이 공유하는 runtime-소스 read-only
// 승인 경계. 두 진입점의 경계가 갈리면 안 되므로 여기 한 곳만 진실이다
// (back-channel 설계 §10 "포크하지 말고 공유").
export function isRuntimeSourcedReadOnlyToolAllowed(
  toolName: string,
  meta: Partial<ToolMeta>,
  runtimeSideEffectLevel: ToolMeta['sideEffectLevel'],
): boolean {
  return (
    (runtimeSideEffectLevel === 'none' || runtimeSideEffectLevel === 'read') &&
    isPtcExecuteCodeCallbackToolMetaAllowed(toolName, meta)
  );
}

export function isPtcExecuteCodeCallbackToolMetaAllowed(
  toolName: string,
  meta: Partial<ToolMeta>,
): boolean {
  const exposure = meta.exposure;
  return (
    isPtcExecuteCodeCallbackToolNameEligible(toolName) &&
    exposure?.sdkVisible === true &&
    exposure.inCellCallable &&
    !exposure.directOnly &&
    exposure.effectClass === 'readOnly' &&
    meta.requiresApproval === false &&
    (meta.sideEffectLevel === 'none' || meta.sideEffectLevel === 'read') &&
    meta.mayMutateComputerFiles === false
  );
}

export function isPtcExecuteCodeWriteCallbackToolMetaAllowed(
  toolName: string,
  meta: Partial<ToolMeta>,
): boolean {
  return (
    PTC_EXECUTE_CODE_WRITE_CALLBACK_TOOL_ALLOWLIST.has(toolName) &&
    isPtcExecuteCodeCallbackToolNameEligible(toolName) &&
    meta.requiresApproval === true &&
    meta.sideEffectLevel === 'write' &&
    meta.mayMutateComputerFiles === true
  );
}

function isPtcExecuteCodeCallbackToolNameEligible(toolName: string): boolean {
  return (
    toolName !== PTC_EXECUTE_CODE_TOOL_NAME &&
    toolName !== PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME &&
    toolName !== PTC_EXECUTE_CODE_WAIT_TOOL_NAME &&
    !toolName.startsWith(AGENT_ORCHESTRATION_TOOL_PREFIX)
  );
}

function toCallbackHelpTool(
  definition: ToolDefinition,
  options: { write?: boolean } = {},
): PtcExecuteCodeRuntimeSdkHelpTool {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    parameters: cloneToolParameters(definition.parameters),
    ...(options.write === true ? { requiresApproval: true as const } : {}),
  });
}
