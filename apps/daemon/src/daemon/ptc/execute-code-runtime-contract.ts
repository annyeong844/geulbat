export const PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION =
  'ptc_execute_code_sdk_v1' as const;

export interface PtcExecuteCodeRuntimeToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface PtcExecuteCodeRuntimeSdkHelpTool {
  name: string;
  description: string;
  parameters: PtcExecuteCodeRuntimeToolParameters;
}

export interface PtcExecuteCodeRuntimeSdkHelp {
  callbackTools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
}

export type PtcExecuteCodeRuntimeToolCallbackResult =
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; message: string };

export type PtcExecuteCodeRuntimeToolCallbackHandler = (invocation: {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<PtcExecuteCodeRuntimeToolCallbackResult>;
