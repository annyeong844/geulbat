export const TOOL_SDK_RELEASE = {
  packageVersion: '0.1.0',
  apiVersion: '1',
  transportProtocolVersion: '1',
  projectionSchemaVersion: '1',
  runtimeCompatibility: {
    versionAxis: 'transportProtocolVersion',
    range: '1.x',
  },
  moduleFormat: 'esm',
  nodeVersion: '>=24.0.0',
} as const;

export const TOOL_SDK_CAPABILITIES = [
  'tool.invoke',
  'tool-output.recover',
] as const;

export const TOOL_SDK_PUBLIC_TOOLS = ['files.read', 'files.list'] as const;

export type ToolSdkCapability = (typeof TOOL_SDK_CAPABILITIES)[number];
export type ToolSdkPublicTool = (typeof TOOL_SDK_PUBLIC_TOOLS)[number];

export type ToolSdkJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly ToolSdkJsonValue[]
  | { readonly [key: string]: ToolSdkJsonValue };

export interface ToolSdkProjectionIdentity {
  schemaVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
}

export interface ToolSdkCompatibility {
  packageVersion: string;
  apiVersion: string;
  transportProtocolVersion: string;
  runtimeCompatibility: ToolSdkRuntimeCompatibility;
  projection: ToolSdkProjectionIdentity;
}

export interface ToolSdkRuntimeCompatibility {
  versionAxis: string;
  range: string;
}

export interface ToolSdkCredential {
  scheme: string;
  value: string;
}

export interface ToolSdkCredentialProvider {
  getCredential(options: {
    signal?: AbortSignal;
  }): Promise<ToolSdkCredential | undefined>;
}

export interface ToolSdkTransportContext {
  credential: ToolSdkCredential;
  signal?: AbortSignal;
}

export interface ToolSdkHandshakeRequest {
  compatibility: ToolSdkCompatibility;
  requestedCapabilities: readonly ToolSdkCapability[];
  requestedPublicTools: readonly ToolSdkPublicTool[];
}

export interface ToolSdkHandshakeAcceptance {
  compatibility: ToolSdkCompatibility;
  capabilities: readonly ToolSdkCapability[];
  publicTools: readonly ToolSdkPublicTool[];
}

export interface ToolSdkInvokeRequest {
  compatibility: ToolSdkCompatibility;
  publicTool: ToolSdkPublicTool;
  input: { readonly [key: string]: ToolSdkJsonValue };
}

export interface ToolSdkOutputRecoveryRequest {
  compatibility: ToolSdkCompatibility;
  outputRef: string;
}

export interface ToolSdkInlineResult {
  kind: 'inline';
  value: ToolSdkJsonValue;
}

export interface ToolSdkOffloadedResult {
  kind: 'offloaded';
  outputRef: string;
}

export type ToolSdkFailureCode =
  | 'approval_denied'
  | 'approval_required'
  | 'authentication_invalid'
  | 'authentication_required'
  | 'cancelled'
  | 'capability_unavailable'
  | 'handshake_required'
  | 'incompatible_sdk'
  | 'incompatible_transport'
  | 'invalid_arguments'
  | 'invalid_transport_response'
  | 'policy_mismatch'
  | 'projection_mismatch'
  | 'tool_failed'
  | 'tool_not_admitted'
  | 'transport_failed';

export interface ToolSdkFailure {
  ok: false;
  error: {
    code: ToolSdkFailureCode;
    message: string;
    retryable: boolean;
  };
}

export type ToolSdkResult<Value> = { ok: true; value: Value } | ToolSdkFailure;

export interface ToolSdkTransport {
  handshake(
    request: ToolSdkHandshakeRequest,
    context: ToolSdkTransportContext,
  ): Promise<ToolSdkResult<ToolSdkHandshakeAcceptance>>;
  invoke(
    request: ToolSdkInvokeRequest,
    context: ToolSdkTransportContext,
  ): Promise<ToolSdkResult<ToolSdkInlineResult | ToolSdkOffloadedResult>>;
  recoverOutput?(
    request: ToolSdkOutputRecoveryRequest,
    context: ToolSdkTransportContext,
  ): Promise<ToolSdkResult<ToolSdkInlineResult>>;
}

export interface ToolSdkCallOptions {
  signal?: AbortSignal;
}
