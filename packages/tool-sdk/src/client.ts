import {
  TOOL_SDK_CAPABILITIES,
  TOOL_SDK_PUBLIC_TOOLS,
  TOOL_SDK_RELEASE,
  type ToolSdkCallOptions,
  type ToolSdkCapability,
  type ToolSdkCompatibility,
  type ToolSdkCredential,
  type ToolSdkCredentialProvider,
  type ToolSdkFailure,
  type ToolSdkFailureCode,
  type ToolSdkHandshakeAcceptance,
  type ToolSdkJsonValue,
  type ToolSdkProjectionIdentity,
  type ToolSdkPublicTool,
  type ToolSdkResult,
  type ToolSdkTransport,
  type ToolSdkTransportContext,
} from './contracts.js';
import {
  encodeListFilesInput,
  encodeReadFileInput,
  parseListFilesOutput,
  parseReadFileOutput,
  readListFilesInput,
  readReadFileInput,
  type ListFilesInput,
  type ListFilesOutput,
  type ReadFileInput,
  type ReadFileOutput,
} from './files.js';

export interface ToolSdkClient {
  connect(
    options?: ToolSdkCallOptions,
  ): Promise<ToolSdkResult<ToolSdkHandshakeAcceptance>>;
  readFile(
    input: ReadFileInput,
    options?: ToolSdkCallOptions,
  ): Promise<ToolSdkResult<ReadFileOutput>>;
  listFiles(
    input: ListFilesInput,
    options?: ToolSdkCallOptions,
  ): Promise<ToolSdkResult<ListFilesOutput>>;
}

export interface CreateToolSdkClientOptions {
  transport: ToolSdkTransport;
  credentialProvider: ToolSdkCredentialProvider;
  projection: ToolSdkProjectionIdentity;
  requestedPublicTools?: readonly ToolSdkPublicTool[];
}

const FAILURE_CODES = new Set<string>([
  'approval_denied',
  'approval_required',
  'authentication_invalid',
  'authentication_required',
  'cancelled',
  'capability_unavailable',
  'handshake_required',
  'incompatible_sdk',
  'incompatible_transport',
  'invalid_arguments',
  'invalid_transport_response',
  'policy_mismatch',
  'projection_mismatch',
  'tool_failed',
  'tool_not_admitted',
  'transport_failed',
]);
const PUBLIC_TOOL_NAMES = new Set<string>(TOOL_SDK_PUBLIC_TOOLS);

export function createToolSdkClient(
  options: CreateToolSdkClientOptions,
): ToolSdkClient {
  const projection = { ...options.projection };
  const compatibility = createCompatibility(projection);
  let configuredPublicTools: unknown = options.requestedPublicTools;
  if (configuredPublicTools === undefined) {
    configuredPublicTools = [...TOOL_SDK_PUBLIC_TOOLS];
  } else if (Array.isArray(configuredPublicTools)) {
    configuredPublicTools = [...(configuredPublicTools as readonly unknown[])];
  }
  const requestedCapabilities: ToolSdkCapability[] =
    options.transport.recoverOutput === undefined
      ? ['tool.invoke']
      : ['tool.invoke', 'tool-output.recover'];
  let connection: ToolSdkHandshakeAcceptance | undefined;

  async function invokePublicTool<Output>(args: {
    publicTool: ToolSdkPublicTool;
    input: { [key: string]: ToolSdkJsonValue };
    signal: AbortSignal | undefined;
    validateOutput(value: unknown): ToolSdkResult<Output>;
  }): Promise<ToolSdkResult<Output>> {
    const activeConnection = connection;
    if (activeConnection === undefined) {
      return failure(
        'handshake_required',
        'The Tool SDK client must complete its compatibility handshake first',
      );
    }
    if (
      !activeConnection.capabilities.includes('tool.invoke') ||
      !activeConnection.publicTools.includes(args.publicTool)
    ) {
      return failure(
        'tool_not_admitted',
        'The requested public tool is not admitted by this connection',
      );
    }

    const credential = await resolveCredential(
      options.credentialProvider,
      args.signal,
    );
    if (!credential.ok) {
      return credential;
    }

    let response: unknown;
    try {
      response = await options.transport.invoke(
        {
          compatibility: copyCompatibility(compatibility),
          publicTool: args.publicTool,
          input: args.input,
        },
        createTransportContext(credential.value, args.signal),
      );
    } catch {
      return transportException(args.signal);
    }

    const invocation = readResult(response);
    if (!invocation.ok) {
      return invocation;
    }
    const inline = await resolveInlineResult({
      compatibility,
      connection: activeConnection,
      credentialProvider: options.credentialProvider,
      result: invocation.value,
      signal: args.signal,
      transport: options.transport,
    });
    return inline.ok ? args.validateOutput(inline.value) : inline;
  }

  return {
    async connect(callOptions = {}) {
      connection = undefined;
      const projectionFailure = validateProjectionIdentity(projection);
      if (projectionFailure !== null) {
        return projectionFailure;
      }
      const requestedPublicTools = readRequestedPublicTools(
        configuredPublicTools,
      );
      if (!requestedPublicTools.ok) {
        return requestedPublicTools;
      }

      const credential = await resolveCredential(
        options.credentialProvider,
        callOptions.signal,
      );
      if (!credential.ok) {
        return credential;
      }

      let response: unknown;
      try {
        response = await options.transport.handshake(
          {
            compatibility: copyCompatibility(compatibility),
            requestedCapabilities: [...requestedCapabilities],
            requestedPublicTools: [...requestedPublicTools.value],
          },
          createTransportContext(credential.value, callOptions.signal),
        );
      } catch {
        return transportException(callOptions.signal);
      }

      const result = readResult(response);
      if (!result.ok) {
        return result;
      }
      const acceptance = validateHandshakeAcceptance(
        result.value,
        compatibility,
        requestedCapabilities,
        requestedPublicTools.value,
      );
      if (!acceptance.ok) {
        return acceptance;
      }
      connection = acceptance.value;
      return acceptance;
    },

    async readFile(input, callOptions = {}) {
      const parsedInput = readReadFileInput(input);
      if (!parsedInput.ok) {
        return failure('invalid_arguments', parsedInput.message);
      }
      return invokePublicTool({
        publicTool: 'files.read',
        input: encodeReadFileInput(parsedInput.value),
        signal: callOptions.signal,
        validateOutput: (value) =>
          readTransportOutput(value, (candidate) =>
            parseReadFileOutput(candidate, parsedInput.value.limit),
          ),
      });
    },

    async listFiles(input, callOptions = {}) {
      const parsedInput = readListFilesInput(input);
      if (!parsedInput.ok) {
        return failure('invalid_arguments', parsedInput.message);
      }
      return invokePublicTool({
        publicTool: 'files.list',
        input: encodeListFilesInput(parsedInput.value),
        signal: callOptions.signal,
        validateOutput: (value) =>
          readTransportOutput(value, parseListFilesOutput),
      });
    },
  };
}

function createCompatibility(
  projection: ToolSdkProjectionIdentity,
): ToolSdkCompatibility {
  return {
    packageVersion: TOOL_SDK_RELEASE.packageVersion,
    apiVersion: TOOL_SDK_RELEASE.apiVersion,
    transportProtocolVersion: TOOL_SDK_RELEASE.transportProtocolVersion,
    runtimeCompatibility: { ...TOOL_SDK_RELEASE.runtimeCompatibility },
    projection: { ...projection },
  };
}

function copyCompatibility(
  compatibility: ToolSdkCompatibility,
): ToolSdkCompatibility {
  return {
    ...compatibility,
    runtimeCompatibility: { ...compatibility.runtimeCompatibility },
    projection: { ...compatibility.projection },
  };
}

async function resolveCredential(
  provider: ToolSdkCredentialProvider,
  signal: AbortSignal | undefined,
): Promise<ToolSdkResult<ToolSdkCredential>> {
  if (isAborted(signal)) {
    return failure('cancelled', 'The Tool SDK call was cancelled');
  }
  let credential: ToolSdkCredential | undefined;
  try {
    credential = await provider.getCredential(
      signal === undefined ? {} : { signal },
    );
  } catch {
    return isAborted(signal)
      ? failure('cancelled', 'The Tool SDK call was cancelled')
      : failure(
          'authentication_invalid',
          'The embedding host could not provide a valid credential',
        );
  }
  if (isAborted(signal)) {
    return failure('cancelled', 'The Tool SDK call was cancelled');
  }
  if (credential === undefined) {
    return failure(
      'authentication_required',
      'The embedding host did not provide a credential',
    );
  }
  if (
    typeof credential.scheme !== 'string' ||
    credential.scheme.trim().length === 0 ||
    typeof credential.value !== 'string' ||
    credential.value.length === 0
  ) {
    return failure(
      'authentication_invalid',
      'The embedding host provided an invalid credential',
    );
  }
  return {
    ok: true,
    value: { scheme: credential.scheme, value: credential.value },
  };
}

async function resolveInlineResult(args: {
  compatibility: ToolSdkCompatibility;
  connection: ToolSdkHandshakeAcceptance;
  credentialProvider: ToolSdkCredentialProvider;
  result: unknown;
  signal: AbortSignal | undefined;
  transport: ToolSdkTransport;
}): Promise<ToolSdkResult<unknown>> {
  if (!isRecord(args.result)) {
    return invalidTransportResponse();
  }
  if (args.result['kind'] === 'inline') {
    return Object.hasOwn(args.result, 'value')
      ? { ok: true, value: args.result['value'] }
      : invalidTransportResponse();
  }
  if (
    args.result['kind'] !== 'offloaded' ||
    typeof args.result['outputRef'] !== 'string' ||
    args.result['outputRef'].trim().length === 0
  ) {
    return invalidTransportResponse();
  }
  if (!args.connection.capabilities.includes('tool-output.recover')) {
    return failure(
      'capability_unavailable',
      'The transport returned offloaded output without negotiating recovery',
    );
  }
  const recoverOutput = args.transport.recoverOutput?.bind(args.transport);
  if (recoverOutput === undefined) {
    return failure(
      'capability_unavailable',
      'The negotiated transport does not implement output recovery',
    );
  }

  const credential = await resolveCredential(
    args.credentialProvider,
    args.signal,
  );
  if (!credential.ok) {
    return credential;
  }

  let response: unknown;
  try {
    response = await recoverOutput(
      {
        compatibility: copyCompatibility(args.compatibility),
        outputRef: args.result['outputRef'],
      },
      createTransportContext(credential.value, args.signal),
    );
  } catch {
    return transportException(args.signal);
  }
  const recovered = readResult(response);
  if (!recovered.ok) {
    return recovered;
  }
  if (
    !isRecord(recovered.value) ||
    recovered.value['kind'] !== 'inline' ||
    !Object.hasOwn(recovered.value, 'value')
  ) {
    return invalidTransportResponse();
  }
  return { ok: true, value: recovered.value['value'] };
}

function validateHandshakeAcceptance(
  value: unknown,
  expected: ToolSdkCompatibility,
  requestedCapabilities: readonly ToolSdkCapability[],
  requestedPublicTools: readonly ToolSdkPublicTool[],
): ToolSdkResult<ToolSdkHandshakeAcceptance> {
  if (!isRecord(value)) {
    return invalidTransportResponse();
  }
  const compatibilityResult = validateCompatibility(
    value['compatibility'],
    expected,
  );
  if (!compatibilityResult.ok) {
    return compatibilityResult;
  }
  const capabilities = readStringArray(value['capabilities']);
  const publicTools = readStringArray(value['publicTools']);
  if (capabilities === null || publicTools === null) {
    return invalidTransportResponse();
  }
  if (
    capabilities.some(
      (capability) =>
        !TOOL_SDK_CAPABILITIES.includes(capability as ToolSdkCapability),
    ) ||
    publicTools.some(
      (publicTool) =>
        !TOOL_SDK_PUBLIC_TOOLS.includes(publicTool as ToolSdkPublicTool),
    )
  ) {
    return invalidTransportResponse();
  }
  if (
    requestedCapabilities.some(
      (capability) => !capabilities.includes(capability),
    )
  ) {
    return failure(
      'capability_unavailable',
      'The transport did not negotiate a requested capability',
    );
  }
  if (
    requestedPublicTools.some((publicTool) => !publicTools.includes(publicTool))
  ) {
    return failure(
      'tool_not_admitted',
      'The host did not admit a requested public tool',
    );
  }
  return {
    ok: true,
    value: {
      compatibility: compatibilityResult.value,
      capabilities: capabilities as ToolSdkCapability[],
      publicTools: publicTools as ToolSdkPublicTool[],
    },
  };
}

function validateCompatibility(
  value: unknown,
  expected: ToolSdkCompatibility,
): ToolSdkResult<ToolSdkCompatibility> {
  if (
    !isRecord(value) ||
    !isRecord(value['projection']) ||
    !isRecord(value['runtimeCompatibility'])
  ) {
    return invalidTransportResponse();
  }
  const projection = value['projection'];
  const fields = [
    value['packageVersion'],
    value['apiVersion'],
    value['transportProtocolVersion'],
    value['runtimeCompatibility']['versionAxis'],
    value['runtimeCompatibility']['range'],
    projection['schemaVersion'],
    projection['sdkProjectionHash'],
    projection['policyId'],
  ];
  if (fields.some((field) => typeof field !== 'string')) {
    return invalidTransportResponse();
  }
  if (
    value['packageVersion'] !== expected.packageVersion ||
    value['apiVersion'] !== expected.apiVersion
  ) {
    return failure(
      'incompatible_sdk',
      'The host is incompatible with this Tool SDK release',
    );
  }
  if (
    value['transportProtocolVersion'] !== expected.transportProtocolVersion ||
    value['runtimeCompatibility']['versionAxis'] !==
      expected.runtimeCompatibility.versionAxis ||
    value['runtimeCompatibility']['range'] !==
      expected.runtimeCompatibility.range
  ) {
    return failure(
      'incompatible_transport',
      'The host uses an incompatible Tool SDK transport protocol',
    );
  }
  if (
    projection['schemaVersion'] !== expected.projection.schemaVersion ||
    projection['sdkProjectionHash'] !== expected.projection.sdkProjectionHash
  ) {
    return failure(
      'projection_mismatch',
      'The host projection does not match the requested projection',
    );
  }
  if (projection['policyId'] !== expected.projection.policyId) {
    return failure(
      'policy_mismatch',
      'The host policy does not match the requested projection policy',
    );
  }
  return { ok: true, value: createCompatibility(expected.projection) };
}

function validateProjectionIdentity(
  projection: ToolSdkProjectionIdentity,
): ToolSdkFailure | null {
  if (
    typeof projection.schemaVersion !== 'string' ||
    projection.schemaVersion !== TOOL_SDK_RELEASE.projectionSchemaVersion
  ) {
    return failure(
      'projection_mismatch',
      'The requested projection schema is incompatible with this Tool SDK release',
    );
  }
  if (
    typeof projection.sdkProjectionHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(projection.sdkProjectionHash)
  ) {
    return failure(
      'projection_mismatch',
      'The requested projection hash is invalid',
    );
  }
  if (
    typeof projection.policyId !== 'string' ||
    projection.policyId.trim().length === 0
  ) {
    return failure(
      'policy_mismatch',
      'The requested policy identity is invalid',
    );
  }
  return null;
}

function readRequestedPublicTools(
  value: unknown,
): ToolSdkResult<ToolSdkPublicTool[]> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== 'string' || !PUBLIC_TOOL_NAMES.has(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    return failure(
      'invalid_arguments',
      'requestedPublicTools must contain unique supported public tool names',
    );
  }
  return { ok: true, value: value as ToolSdkPublicTool[] };
}

function readTransportOutput<Output>(
  value: unknown,
  parse: (candidate: unknown) => Output | null,
): ToolSdkResult<Output> {
  const output = parse(value);
  return output === null
    ? invalidTransportResponse()
    : { ok: true, value: output };
}

function readResult(value: unknown): ToolSdkResult<unknown> {
  if (!isRecord(value)) {
    return invalidTransportResponse();
  }
  if (value['ok'] === true && Object.hasOwn(value, 'value')) {
    return { ok: true, value: value['value'] };
  }
  if (value['ok'] !== false || !isRecord(value['error'])) {
    return invalidTransportResponse();
  }
  const error = value['error'];
  if (
    typeof error['code'] !== 'string' ||
    !FAILURE_CODES.has(error['code']) ||
    typeof error['message'] !== 'string' ||
    typeof error['retryable'] !== 'boolean'
  ) {
    return invalidTransportResponse();
  }
  return failure(
    error['code'] as ToolSdkFailureCode,
    error['message'],
    error['retryable'],
  );
}

function failure(
  code: ToolSdkFailureCode,
  message: string,
  retryable = false,
): ToolSdkFailure {
  return { ok: false, error: { code, message, retryable } };
}

function invalidTransportResponse(): ToolSdkFailure {
  return failure(
    'invalid_transport_response',
    'The Tool SDK transport returned an invalid response',
  );
}

function transportException(signal: AbortSignal | undefined): ToolSdkFailure {
  return signal?.aborted === true
    ? failure('cancelled', 'The Tool SDK call was cancelled')
    : failure(
        'transport_failed',
        'The Tool SDK transport failed before returning a response',
        true,
      );
}

function createTransportContext(
  credential: ToolSdkCredential,
  signal: AbortSignal | undefined,
): ToolSdkTransportContext {
  return signal === undefined ? { credential } : { credential, signal };
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    new Set(value).size === value.length
    ? [...value]
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
