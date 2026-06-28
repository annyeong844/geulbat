import {
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import type { ToolExecutionContext } from '../types.js';
import {
  resolvePtcExecuteCodeCallbackToolSurface,
  type PtcExecuteCodeCallbackToolSurface,
} from './ptc-callback-tool-surface.js';

export function createPtcExecuteCodeToolCallbackSurface(
  ctx: ToolExecutionContext,
): PtcExecuteCodeCallbackToolSurface | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined) {
    return undefined;
  }

  return resolvePtcExecuteCodeCallbackToolSurface({
    registry,
    ...(ctx.allowedToolNames !== undefined
      ? { allowedToolNames: ctx.allowedToolNames }
      : {}),
  });
}

export function createPtcExecuteCodeToolCallbackHandler(
  ctx: ToolExecutionContext,
  surface:
    | PtcExecuteCodeCallbackToolSurface
    | undefined = createPtcExecuteCodeToolCallbackSurface(ctx),
): PtcExecuteCodeRuntimeToolCallbackHandler | undefined {
  const registry = ctx.agentSpawnRuntime?.toolRegistry;
  if (registry === undefined || surface === undefined) {
    return undefined;
  }
  const dispatcher = ctx.callbackToolDispatcher;

  return async (invocation) => {
    const meta = registry.getToolMeta(invocation.toolName);
    if (meta === null) {
      return {
        ok: false,
        errorCode: 'ptc_tool_unknown',
        message: 'PTC execute_code callback requested an unknown tool',
      };
    }
    if (!surface.allows(invocation.toolName)) {
      return {
        ok: false,
        errorCode: 'ptc_tool_not_callable',
        message:
          'PTC execute_code callback can only call read-only no-approval non-orchestration tools',
      };
    }
    if (dispatcher === undefined) {
      return {
        ok: false,
        errorCode: 'ptc_tool_dispatch_unavailable',
        message: 'PTC execute_code callback dispatcher is unavailable',
      };
    }
    if (invocation.enterLongWait?.() === false) {
      return {
        ok: false,
        errorCode: 'ptc_tool_callback_watchdog_elapsed',
        message: 'PTC execute_code callback admission watchdog already elapsed',
      };
    }

    try {
      const result = await dispatcher.dispatch({
        toolName: invocation.toolName,
        args: invocation.args,
        runtimeToolCallId: invocation.requestId,
        ...(invocation.cellId !== undefined
          ? { cellId: invocation.cellId }
          : {}),
        signal: invocation.signal,
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        errorCode: 'ptc_tool_dispatch_failed',
        message: getErrorMessage(error),
      };
    }
  };
}

export function createPtcExecuteCodeToolCallbackHelp(
  ctx: ToolExecutionContext,
  surface:
    | PtcExecuteCodeCallbackToolSurface
    | undefined = createPtcExecuteCodeToolCallbackSurface(ctx),
): PtcExecuteCodeRuntimeSdkHelp | undefined {
  if (surface === undefined || ctx.callbackToolDispatcher === undefined) {
    return undefined;
  }

  return { callbackTools: surface.callbackTools };
}
