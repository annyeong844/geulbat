import {
  TOOL_SDK_PUBLIC_TOOLS,
  TOOL_SDK_RELEASE,
  type ToolSdkCapability,
  type ToolSdkCompatibility,
  type ToolSdkCredential,
  type ToolSdkFailure,
  type ToolSdkFailureCode,
  type ToolSdkHandshakeAcceptance,
  type ToolSdkJsonValue,
  type ToolSdkOutputRecoveryRequest,
  type ToolSdkProjectionIdentity,
  type ToolSdkPublicTool,
  type ToolSdkResult,
  type ToolSdkTransport,
  type ToolSdkTransportContext,
} from '@geulbat/tool-sdk';

import { readToolOutputSnapshot } from '../files/tool-output-store.js';
import { executeTool } from './executor.js';
import type { ToolRegistryStore } from './tool-registry-model.js';
import type { ExecuteResult, ToolExecutionContext } from './types.js';

type PublicToolInlineResult = ToolSdkResult<{
  kind: 'inline';
  value: ToolSdkJsonValue;
}>;

type PublicToolResult = ToolSdkResult<
  | { kind: 'inline'; value: ToolSdkJsonValue }
  | { kind: 'offloaded'; outputRef: string }
>;

interface PublicToolBinding {
  internalTool: string;
  normalizeResult(output: string): PublicToolInlineResult;
}

const PUBLIC_TOOL_BINDINGS = {
  'files.read': {
    internalTool: 'read_file',
    normalizeResult: normalizeReadFileResult,
  },
  'files.list': {
    internalTool: 'list_files',
    normalizeResult: normalizeListFilesResult,
  },
} satisfies Record<ToolSdkPublicTool, PublicToolBinding>;

const PUBLIC_TOOL_NAMES = new Set<string>(TOOL_SDK_PUBLIC_TOOLS);

type DaemonToolSdkAuthenticationResult<Principal> =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      code: 'authentication_invalid' | 'authentication_required';
    };

type DaemonToolSdkInvocationAdmission =
  | { ok: true; context: ToolExecutionContext }
  | {
      ok: false;
      code: 'approval_denied' | 'approval_required' | 'tool_not_admitted';
    };

type DaemonToolSdkOutputOffloader = (options: {
  internalTool: string;
  input: Readonly<Record<string, ToolSdkJsonValue>>;
  context: ToolExecutionContext;
  output: string;
}) => Promise<ExecuteResult>;

interface DaemonToolSdkAuthority<Principal> {
  authenticate(
    credential: ToolSdkCredential,
    options: { signal?: AbortSignal },
  ): Promise<DaemonToolSdkAuthenticationResult<Principal>>;
  authorizeInvocation(options: {
    principal: Principal;
    projection: ToolSdkProjectionIdentity;
    publicTool: ToolSdkPublicTool;
    input: Readonly<Record<string, ToolSdkJsonValue>>;
    signal?: AbortSignal;
  }): Promise<DaemonToolSdkInvocationAdmission>;
  authorizeOutputRecovery?(options: {
    principal: Principal;
    projection: ToolSdkProjectionIdentity;
    outputRef: string;
    signal?: AbortSignal;
  }): Promise<DaemonToolSdkInvocationAdmission>;
}

export interface CreateDaemonToolSdkTransportOptions<Principal> {
  authority: DaemonToolSdkAuthority<Principal>;
  getProjectionIdentity(): ToolSdkProjectionIdentity;
  offloadResult?: DaemonToolSdkOutputOffloader;
  registry: Pick<ToolRegistryStore, 'getTool' | 'getToolMeta'>;
}

export function createDaemonToolSdkTransport<Principal>(
  options: CreateDaemonToolSdkTransportOptions<Principal>,
): ToolSdkTransport {
  const authorizeOutputRecovery =
    options.authority.authorizeOutputRecovery?.bind(options.authority);
  const getProjectionIdentity = options.getProjectionIdentity.bind(options);
  const capabilities: readonly ToolSdkCapability[] =
    authorizeOutputRecovery === undefined
      ? ['tool.invoke']
      : ['tool.invoke', 'tool-output.recover'];
  const transport: ToolSdkTransport = {
    async handshake(request, context) {
      const authentication = await authenticate(options.authority, context);
      if (!authentication.ok) {
        return authentication;
      }
      const compatibility = readCurrentCompatibility(getProjectionIdentity);
      if (!compatibility.ok) {
        return compatibility;
      }
      const compatibilityFailure = compareCompatibility(
        request.compatibility,
        compatibility.value,
      );
      if (compatibilityFailure !== null) {
        return compatibilityFailure;
      }
      if (
        !Array.isArray(request.requestedCapabilities) ||
        request.requestedCapabilities.length !== capabilities.length ||
        request.requestedCapabilities.some(
          (capability, index) => capability !== capabilities[index],
        )
      ) {
        return failure(
          'capability_unavailable',
          'A requested Tool SDK capability is unavailable',
        );
      }
      const requestedPublicTools = readRequestedPublicTools(
        request.requestedPublicTools,
      );
      if (
        requestedPublicTools === null ||
        requestedPublicTools.some(
          (publicTool) =>
            !isPublicToolCurrentlyAdmitted(options.registry, publicTool),
        )
      ) {
        return failure(
          'tool_not_admitted',
          'A requested public tool is not currently admitted',
        );
      }
      return {
        ok: true,
        value: {
          compatibility: compatibility.value,
          capabilities,
          publicTools: requestedPublicTools,
        },
      } satisfies ToolSdkResult<ToolSdkHandshakeAcceptance>;
    },

    async invoke(request, context) {
      const authentication = await authenticate(options.authority, context);
      if (!authentication.ok) {
        return authentication;
      }
      let compatibility = readCurrentCompatibility(getProjectionIdentity);
      if (!compatibility.ok) {
        return compatibility;
      }
      let compatibilityFailure = compareCompatibility(
        request.compatibility,
        compatibility.value,
      );
      if (compatibilityFailure !== null) {
        return compatibilityFailure;
      }
      const publicTool = readPublicTool(request.publicTool);
      const input = readJsonObjectSnapshot(request.input);
      if (
        publicTool === null ||
        input === null ||
        !isPublicToolCurrentlyAdmitted(options.registry, publicTool)
      ) {
        return failure(
          'tool_not_admitted',
          'The requested public tool is not currently admitted',
        );
      }
      const binding = PUBLIC_TOOL_BINDINGS[publicTool];

      let admission: DaemonToolSdkInvocationAdmission;
      try {
        admission = await options.authority.authorizeInvocation({
          principal: authentication.value,
          projection: compatibility.value.projection,
          publicTool,
          input,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      } catch {
        return failure(
          'transport_failed',
          'The daemon could not authorize the Tool SDK invocation',
          true,
        );
      }
      if (!admission.ok) {
        return authorityFailure(admission.code);
      }

      compatibility = readCurrentCompatibility(getProjectionIdentity);
      if (!compatibility.ok) {
        return compatibility;
      }
      compatibilityFailure = compareCompatibility(
        request.compatibility,
        compatibility.value,
      );
      if (compatibilityFailure !== null) {
        return compatibilityFailure;
      }
      if (!isPublicToolCurrentlyAdmitted(options.registry, publicTool)) {
        return failure(
          'tool_not_admitted',
          'The requested public tool is not currently admitted',
        );
      }

      const executionContext = applyInvocationSignal(
        admission.context,
        context.signal,
      );
      const result = await executeTool(
        binding.internalTool,
        input,
        executionContext,
        { toolRegistry: options.registry },
      );
      if (!result.ok) {
        return mapToolFailure(result.errorCode);
      }
      return projectInvocationResult({
        binding,
        context: executionContext,
        input,
        internalTool: binding.internalTool,
        offloadResult:
          authorizeOutputRecovery === undefined
            ? undefined
            : options.offloadResult,
        result,
      });
    },
  };

  if (authorizeOutputRecovery === undefined) {
    return transport;
  }

  return {
    ...transport,
    async recoverOutput(request, context) {
      return recoverDaemonToolSdkOutput({
        authorizeOutputRecovery,
        context,
        options,
        request,
      });
    },
  };
}

async function recoverDaemonToolSdkOutput<Principal>(args: {
  authorizeOutputRecovery: NonNullable<
    DaemonToolSdkAuthority<Principal>['authorizeOutputRecovery']
  >;
  context: ToolSdkTransportContext;
  options: CreateDaemonToolSdkTransportOptions<Principal>;
  request: ToolSdkOutputRecoveryRequest;
}): Promise<PublicToolInlineResult> {
  const getProjectionIdentity = args.options.getProjectionIdentity.bind(
    args.options,
  );
  const authentication = await authenticate(
    args.options.authority,
    args.context,
  );
  if (!authentication.ok) {
    return authentication;
  }
  let compatibility = readCurrentCompatibility(getProjectionIdentity);
  if (!compatibility.ok) {
    return compatibility;
  }
  let compatibilityFailure = compareCompatibility(
    args.request.compatibility,
    compatibility.value,
  );
  if (compatibilityFailure !== null) {
    return compatibilityFailure;
  }
  if (
    typeof args.request.outputRef !== 'string' ||
    args.request.outputRef.trim().length === 0
  ) {
    return failure(
      'invalid_arguments',
      'The Tool SDK output reference is invalid',
    );
  }

  let admission: DaemonToolSdkInvocationAdmission;
  try {
    admission = await args.authorizeOutputRecovery.call(
      args.options.authority,
      {
        principal: authentication.value,
        projection: compatibility.value.projection,
        outputRef: args.request.outputRef,
        ...(args.context.signal === undefined
          ? {}
          : { signal: args.context.signal }),
      },
    );
  } catch {
    return failure(
      'transport_failed',
      'The daemon could not authorize Tool SDK output recovery',
      true,
    );
  }
  if (!admission.ok) {
    return authorityFailure(admission.code, 'output recovery');
  }
  if (isAborted(args.context.signal)) {
    return failure('cancelled', 'The Tool SDK output recovery was cancelled');
  }

  compatibility = readCurrentCompatibility(getProjectionIdentity);
  if (!compatibility.ok) {
    return compatibility;
  }
  compatibilityFailure = compareCompatibility(
    args.request.compatibility,
    compatibility.value,
  );
  if (compatibilityFailure !== null) {
    return compatibilityFailure;
  }

  const recoveryContext = admission.context;
  if (
    typeof recoveryContext.threadId !== 'string' ||
    recoveryContext.threadId.length === 0 ||
    typeof recoveryContext.stateRoot !== 'string' ||
    recoveryContext.stateRoot.length === 0
  ) {
    return failure(
      'transport_failed',
      'The daemon output recovery context is incomplete',
    );
  }

  let snapshotResult: Awaited<ReturnType<typeof readToolOutputSnapshot>>;
  try {
    snapshotResult = await readToolOutputSnapshot({
      stateRoot: recoveryContext.stateRoot,
      threadId: recoveryContext.threadId,
      outputRef: args.request.outputRef,
    });
  } catch {
    return failure(
      'transport_failed',
      'The daemon could not read the requested tool output',
      true,
    );
  }
  if (!snapshotResult.ok) {
    return mapOutputRecoveryFailure(snapshotResult.errorCode);
  }

  compatibility = readCurrentCompatibility(getProjectionIdentity);
  if (!compatibility.ok) {
    return compatibility;
  }
  compatibilityFailure = compareCompatibility(
    args.request.compatibility,
    compatibility.value,
  );
  if (compatibilityFailure !== null) {
    return compatibilityFailure;
  }

  const publicBinding = readPublicBindingForInternalTool(
    snapshotResult.value.toolName,
  );
  if (
    publicBinding === null ||
    !isPublicToolCurrentlyAdmitted(
      args.options.registry,
      publicBinding.publicTool,
    )
  ) {
    return failure(
      'tool_not_admitted',
      'The recovered output tool is not currently admitted',
    );
  }
  return publicBinding.binding.normalizeResult(snapshotResult.value.output);
}

async function projectInvocationResult(args: {
  binding: PublicToolBinding;
  context: ToolExecutionContext;
  input: Readonly<Record<string, ToolSdkJsonValue>>;
  internalTool: string;
  offloadResult: DaemonToolSdkOutputOffloader | undefined;
  result: Extract<ExecuteResult, { ok: true }>;
}): Promise<PublicToolResult> {
  const normalized = args.binding.normalizeResult(args.result.output);
  if (!normalized.ok || args.offloadResult === undefined) {
    return normalized;
  }
  const output = JSON.stringify(normalized.value.value);
  if (output === undefined) {
    return invalidToolResult();
  }

  let projected: ExecuteResult;
  try {
    projected = await args.offloadResult({
      internalTool: args.internalTool,
      input: args.input,
      context: args.context,
      output,
    });
  } catch {
    return failure(
      'transport_failed',
      'The daemon could not project the Tool SDK result',
      true,
    );
  }
  if (!projected.ok) {
    return mapToolFailure(projected.errorCode);
  }
  if (projected.output === output) {
    return normalized;
  }

  const parsed = readToolResultObject(projected.output);
  if (!parsed.ok) {
    return parsed;
  }
  const outputRef = parsed.value['outputRef'];
  if (
    parsed.value['offloaded'] !== true ||
    typeof outputRef !== 'string' ||
    outputRef.trim().length === 0
  ) {
    return invalidToolResult();
  }
  return {
    ok: true,
    value: { kind: 'offloaded', outputRef },
  };
}

function readPublicBindingForInternalTool(toolName: string): {
  publicTool: ToolSdkPublicTool;
  binding: PublicToolBinding;
} | null {
  for (const publicTool of TOOL_SDK_PUBLIC_TOOLS) {
    const binding = PUBLIC_TOOL_BINDINGS[publicTool];
    if (binding.internalTool === toolName) {
      return { publicTool, binding };
    }
  }
  return null;
}

async function authenticate<Principal>(
  authority: DaemonToolSdkAuthority<Principal>,
  context: ToolSdkTransportContext,
): Promise<ToolSdkResult<Principal>> {
  if (isAborted(context.signal)) {
    return failure('cancelled', 'The Tool SDK invocation was cancelled');
  }
  let result: DaemonToolSdkAuthenticationResult<Principal>;
  try {
    result = await authority.authenticate(
      context.credential,
      context.signal === undefined ? {} : { signal: context.signal },
    );
  } catch {
    return failure(
      'authentication_invalid',
      'The daemon could not authenticate the Tool SDK credential',
    );
  }
  if (isAborted(context.signal)) {
    return failure('cancelled', 'The Tool SDK invocation was cancelled');
  }
  return result.ok
    ? { ok: true, value: result.principal }
    : authorityFailure(result.code);
}

function readCurrentCompatibility(
  getProjectionIdentity: () => ToolSdkProjectionIdentity,
): ToolSdkResult<ToolSdkCompatibility> {
  let value: unknown;
  try {
    value = getProjectionIdentity();
  } catch {
    return failure(
      'transport_failed',
      'The daemon could not resolve the current Tool SDK projection',
      true,
    );
  }
  const projection = readProjectionIdentity(value);
  if (projection === null) {
    return failure(
      'projection_mismatch',
      'The daemon Tool SDK projection identity is invalid',
    );
  }
  return {
    ok: true,
    value: {
      packageVersion: TOOL_SDK_RELEASE.packageVersion,
      apiVersion: TOOL_SDK_RELEASE.apiVersion,
      transportProtocolVersion: TOOL_SDK_RELEASE.transportProtocolVersion,
      runtimeCompatibility: { ...TOOL_SDK_RELEASE.runtimeCompatibility },
      projection: { ...projection },
    },
  };
}

function readProjectionIdentity(
  value: unknown,
): ToolSdkProjectionIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const schemaVersion = value['schemaVersion'];
  const sdkProjectionHash = value['sdkProjectionHash'];
  const policyId = value['policyId'];
  if (
    schemaVersion !== TOOL_SDK_RELEASE.projectionSchemaVersion ||
    typeof sdkProjectionHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(sdkProjectionHash) ||
    typeof policyId !== 'string' ||
    policyId.trim().length === 0
  ) {
    return null;
  }
  return {
    schemaVersion,
    sdkProjectionHash: sdkProjectionHash as `sha256:${string}`,
    policyId,
  };
}

function compareCompatibility(
  requested: ToolSdkCompatibility,
  current: ToolSdkCompatibility,
): ToolSdkFailure | null {
  if (
    !isRecord(requested) ||
    !isRecord(requested.projection) ||
    requested.packageVersion !== current.packageVersion ||
    requested.apiVersion !== current.apiVersion
  ) {
    return failure(
      'incompatible_sdk',
      'The Tool SDK release is incompatible with this daemon',
    );
  }
  if (
    !isRecord(requested.runtimeCompatibility) ||
    requested.transportProtocolVersion !== current.transportProtocolVersion ||
    requested.runtimeCompatibility.versionAxis !==
      current.runtimeCompatibility.versionAxis ||
    requested.runtimeCompatibility.range !== current.runtimeCompatibility.range
  ) {
    return failure(
      'incompatible_transport',
      'The Tool SDK transport protocol is incompatible with this daemon',
    );
  }
  if (
    requested.projection.schemaVersion !== current.projection.schemaVersion ||
    requested.projection.sdkProjectionHash !==
      current.projection.sdkProjectionHash
  ) {
    return failure(
      'projection_mismatch',
      'The requested Tool SDK projection is no longer current',
    );
  }
  if (requested.projection.policyId !== current.projection.policyId) {
    return failure(
      'policy_mismatch',
      'The requested Tool SDK policy is no longer current',
    );
  }
  return null;
}

function readRequestedPublicTools(value: unknown): ToolSdkPublicTool[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const publicTools: ToolSdkPublicTool[] = [];
  const seen = new Set<ToolSdkPublicTool>();
  for (const entry of value) {
    const publicTool = readPublicTool(entry);
    if (publicTool === null || seen.has(publicTool)) {
      return null;
    }
    seen.add(publicTool);
    publicTools.push(publicTool);
  }
  return publicTools;
}

function readPublicTool(value: unknown): ToolSdkPublicTool | null {
  return typeof value === 'string' && PUBLIC_TOOL_NAMES.has(value)
    ? (value as ToolSdkPublicTool)
    : null;
}

function isPublicToolCurrentlyAdmitted(
  registry: Pick<ToolRegistryStore, 'getTool' | 'getToolMeta'>,
  publicTool: ToolSdkPublicTool,
): boolean {
  const binding = PUBLIC_TOOL_BINDINGS[publicTool];
  const tool = registry.getTool(binding.internalTool);
  const meta = registry.getToolMeta(binding.internalTool);
  return (
    tool !== undefined &&
    meta !== null &&
    meta.sideEffectLevel === 'read' &&
    meta.mayMutateComputerFiles === false &&
    meta.requiresApproval === false &&
    meta.exposure.sdkVisible &&
    meta.exposure.directOnly === false
  );
}

function applyInvocationSignal(
  context: ToolExecutionContext,
  signal: AbortSignal | undefined,
): ToolExecutionContext {
  return signal === undefined
    ? context
    : { ...context, signal, runSignal: signal };
}

function normalizeReadFileResult(
  output: string,
): ToolSdkResult<{ kind: 'inline'; value: ToolSdkJsonValue }> {
  const parsed = readToolResultObject(output);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const path = value['path'];
  const content = value['content'];
  const versionToken = value['versionToken'];
  const totalLines = value['totalLines'];
  const pageLimit = value['pageLimit'];
  const startLine = value['startLine'];
  const endLine = value['endLine'];
  const hasMore = value['hasMore'];
  const nextOffset = value['nextOffset'];
  if (
    typeof path !== 'string' ||
    typeof content !== 'string' ||
    typeof versionToken !== 'string' ||
    !isNonNegativeSafeInteger(totalLines) ||
    !isPositiveSafeInteger(pageLimit) ||
    !isPositiveSafeInteger(startLine) ||
    !isNonNegativeSafeInteger(endLine) ||
    typeof hasMore !== 'boolean' ||
    (nextOffset !== null && !isNonNegativeSafeInteger(nextOffset))
  ) {
    return invalidToolResult();
  }
  return {
    ok: true,
    value: {
      kind: 'inline',
      value: {
        path,
        content,
        versionToken,
        totalLines,
        pageLimit,
        startLine,
        endLine,
        hasMore,
        nextOffset,
      },
    },
  };
}

function normalizeListFilesResult(output: string): PublicToolInlineResult {
  const parsed = readToolResultObject(output);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const path = value['path'];
  const total = value['total'];
  const rawEntries = value['entries'];
  if (
    typeof path !== 'string' ||
    !isNonNegativeSafeInteger(total) ||
    !Array.isArray(rawEntries) ||
    rawEntries.length !== total
  ) {
    return invalidToolResult();
  }
  const entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
  }> = [];
  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) {
      return invalidToolResult();
    }
    const name = rawEntry['name'];
    const entryPath = rawEntry['path'];
    const type = rawEntry['type'];
    if (
      typeof name !== 'string' ||
      typeof entryPath !== 'string' ||
      (type !== 'file' && type !== 'directory')
    ) {
      return invalidToolResult();
    }
    entries.push({ name, path: entryPath, type });
  }
  return {
    ok: true,
    value: {
      kind: 'inline',
      value: { path, total, entries },
    },
  };
}

function readToolResultObject(
  output: string,
): ToolSdkResult<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return invalidToolResult();
  }
  return isRecord(value) ? { ok: true, value } : invalidToolResult();
}

function invalidToolResult(): ToolSdkFailure {
  return failure(
    'tool_failed',
    'The admitted public tool returned an invalid result',
  );
}

function mapToolFailure(errorCode: string): ToolSdkFailure {
  switch (errorCode) {
    case 'invalid_args':
      return failure(
        'invalid_arguments',
        'The public tool arguments were rejected',
      );
    case 'approval_required':
      return failure(
        'approval_required',
        'The public tool requires a current approval',
      );
    case 'approval_aborted':
    case 'approval_denied':
    case 'approval_timeout':
      return failure(
        'approval_denied',
        'The public tool invocation was not approved',
      );
    case 'aborted':
      return failure('cancelled', 'The public tool invocation was cancelled');
    case 'rate_limited':
    case 'timeout':
      return failure(
        'tool_failed',
        'The public tool could not complete the invocation',
        true,
      );
    default:
      return failure(
        'tool_failed',
        'The public tool could not complete the invocation',
      );
  }
}

function mapOutputRecoveryFailure(errorCode: string): ToolSdkFailure {
  return errorCode === 'invalid_args'
    ? failure('invalid_arguments', 'The Tool SDK output reference is invalid')
    : failure(
        'tool_failed',
        'The requested tool output could not be recovered',
      );
}

function authorityFailure(
  code:
    | 'approval_denied'
    | 'approval_required'
    | 'authentication_invalid'
    | 'authentication_required'
    | 'tool_not_admitted',
  operation: 'invocation' | 'output recovery' = 'invocation',
): ToolSdkFailure {
  const messages: Record<typeof code, string> = {
    approval_denied: `The Tool SDK ${operation} was not approved`,
    approval_required: `The Tool SDK ${operation} requires a current approval`,
    authentication_invalid: 'The Tool SDK credential is invalid',
    authentication_required: `The Tool SDK ${operation} requires authentication`,
    tool_not_admitted:
      operation === 'invocation'
        ? 'The public tool is not admitted for this caller'
        : 'Tool output recovery is not admitted for this caller',
  };
  return failure(code, messages[code]);
}

function failure(
  code: ToolSdkFailureCode,
  message: string,
  retryable = false,
): ToolSdkFailure {
  return { ok: false, error: { code, message, retryable } };
}

function readJsonObjectSnapshot(
  value: unknown,
): Readonly<Record<string, ToolSdkJsonValue>> | null {
  try {
    const snapshot = cloneJsonValue(value, new WeakSet<object>());
    return snapshot.ok && isJsonObjectValue(snapshot.value)
      ? snapshot.value
      : null;
  } catch {
    return null;
  }
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): { ok: true; value: ToolSdkJsonValue } | { ok: false } {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return { ok: false };
  }
  if (ancestors.has(value)) {
    return { ok: false };
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const output: ToolSdkJsonValue[] = [];
    for (const entry of value) {
      const cloned = cloneJsonValue(entry, ancestors);
      if (!cloned.ok) {
        return { ok: false };
      }
      output.push(cloned.value);
    }
    ancestors.delete(value);
    return { ok: true, value: Object.freeze(output) };
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { ok: false };
  }
  const output: Record<string, ToolSdkJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const cloned = cloneJsonValue(entry, ancestors);
    if (!cloned.ok) {
      return { ok: false };
    }
    output[key] = cloned.value;
  }
  ancestors.delete(value);
  return { ok: true, value: Object.freeze(output) };
}

function isJsonObjectValue(
  value: ToolSdkJsonValue,
): value is Readonly<Record<string, ToolSdkJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
