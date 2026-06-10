import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
} from '../../daemon-runtime-contract.js';
import type { ToolMeta } from '../types.js';
import { executeTool } from '../executor.js';
import type { ToolExecutionContext } from '../types.js';

const MAX_CALLBACK_REQUEST_ID_CHARS = 64;

export function createPtcExecuteCodeToolCallbackHandler(
  ctx: ToolExecutionContext,
): PtcExecuteCodeRuntimeToolCallbackHandler | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined) {
    return undefined;
  }

  return async (invocation) => {
    const meta = registry.getToolMeta(invocation.toolName);
    if (meta === null) {
      return {
        ok: false,
        errorCode: 'ptc_tool_unknown',
        message: 'PTC execute_code callback requested an unknown tool',
      };
    }
    if (!isPtcExecuteCodeCallbackToolAllowed(invocation.toolName, meta)) {
      return {
        ok: false,
        errorCode: 'ptc_tool_not_callable',
        message:
          'PTC execute_code callback can only call read-only no-approval tools',
      };
    }

    const result = await executeTool(
      invocation.toolName,
      invocation.args,
      {
        ...ctx,
        callId: toCallbackCallId(invocation.requestId),
        approvalGranted: false,
        signal: invocation.signal,
      },
      { toolRegistry: registry },
    );
    return { ok: true, result };
  };
}

export function createPtcExecuteCodeToolCallbackHelp(
  ctx: ToolExecutionContext,
): PtcExecuteCodeRuntimeSdkHelp | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined) {
    return undefined;
  }

  const callbackTools = registry
    .buildToolDefinitions()
    .filter((definition) => {
      const meta = registry.getToolMeta(definition.name);
      return (
        meta !== null &&
        isPtcExecuteCodeCallbackToolAllowed(definition.name, meta)
      );
    })
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));

  return { callbackTools };
}

export function isPtcExecuteCodeCallbackToolAllowed(
  toolName: string,
  meta: ToolMeta,
): boolean {
  return (
    toolName !== PTC_EXECUTE_CODE_TOOL_NAME &&
    meta.requiresApproval === false &&
    meta.sideEffectLevel === 'read' &&
    meta.mayMutateWorkspaceFiles === false
  );
}

function toCallbackCallId(requestId: string): string {
  return `ptc-execute-code:${requestId.slice(0, MAX_CALLBACK_REQUEST_ID_CHARS)}`;
}
