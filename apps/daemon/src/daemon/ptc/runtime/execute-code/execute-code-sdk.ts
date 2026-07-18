import {
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeSdkHelpTool,
  type PtcExecuteCodeRuntimeSdkProjection,
} from './execute-code-runtime-contract.js';

export { PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION };
export const PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER =
  'geulbat-sdk' as const;

interface PtcExecuteCodeSdkHelpBundle {
  protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
  runtime: {
    language: 'javascript_or_erasable_typescript';
    executionSurface: 'node_via_lab_batch_command';
    sessionLifecycle: 'runtime_owned_reusable';
  };
  callbacks: {
    enabled: boolean;
    callShape: 'geulbat.callTool(name, args)';
    tools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
  };
  helpers: {
    namespace: 'geulbat.tools';
    aliases: readonly PtcExecuteCodeSdkToolAlias[];
  };
  sdkProjection?: {
    sdkVersion: string;
    sdkProjectionHash: `sha256:${string}`;
    policyId: string;
    importSpecifier: string;
    modules: readonly { specifier: string; exportName: string }[];
  };
  runtimeSdkProjection?: PtcExecuteCodeRuntimeSdkProjection;
  store?: {
    enabled: true;
    callShape: 'geulbat.store.get(key) / geulbat.store.set(key, value, options?)';
    consistency: 'snapshot_at_execution_start_merge_at_commit';
    mergePolicy: 'conflict';
    executionMode: 'batch_exec' | 'detached_cell';
  };
}

interface PtcExecuteCodeSdkToolAlias {
  alias: string;
  toolName: string;
}

const PTC_EXECUTE_CODE_SDK_TOOL_ALIASES: readonly PtcExecuteCodeSdkToolAlias[] =
  Object.freeze([
    { alias: 'readFile', toolName: 'read_file' },
    { alias: 'listFiles', toolName: 'list_files' },
    { alias: 'searchFiles', toolName: 'search_files' },
    { alias: 'readToolOutput', toolName: 'read_tool_output' },
    { alias: 'searchMemoryIndex', toolName: 'search_memory_index' },
    { alias: 'fetchUrl', toolName: 'fetch_url' },
    // Write-tier aliases surface only when the write-callback tier admits the
    // tool into callbackTools (default off keeps these filtered out).
    { alias: 'applyPatch', toolName: 'apply_patch' },
    { alias: 'manageFiles', toolName: 'manage_files' },
  ]);

export function buildPtcExecuteCodeSdkHelpBundle(args: {
  callbacksEnabled: boolean;
  sdkHelp: PtcExecuteCodeRuntimeSdkHelp | undefined;
  sdkProjection?: PtcExecuteCodeRuntimeSdkProjection;
  storeMode?: 'batch_exec' | 'detached_cell';
}): PtcExecuteCodeSdkHelpBundle {
  const tools = args.callbacksEnabled
    ? (args.sdkHelp?.callbackTools ?? [])
    : [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  return {
    protocolVersion: PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
    runtime: {
      language: 'javascript_or_erasable_typescript',
      executionSurface: 'node_via_lab_batch_command',
      sessionLifecycle: 'runtime_owned_reusable',
    },
    callbacks: {
      enabled: args.callbacksEnabled,
      callShape: 'geulbat.callTool(name, args)',
      tools,
    },
    helpers: {
      namespace: 'geulbat.tools',
      aliases: PTC_EXECUTE_CODE_SDK_TOOL_ALIASES.filter((alias) =>
        toolNames.has(alias.toolName),
      ),
    },
    ...(args.sdkProjection === undefined
      ? {}
      : {
          sdkProjection: {
            sdkVersion: args.sdkProjection.sdkVersion,
            sdkProjectionHash: args.sdkProjection.sdkProjectionHash,
            policyId: args.sdkProjection.policyId,
            importSpecifier: args.sdkProjection.importSpecifier,
            modules: args.sdkProjection.modules.map((module) => ({
              specifier: module.specifier,
              exportName: module.exportName,
            })),
          },
          runtimeSdkProjection: args.sdkProjection,
        }),
    ...(args.storeMode === undefined
      ? {}
      : {
          store: {
            enabled: true as const,
            callShape:
              'geulbat.store.get(key) / geulbat.store.set(key, value, options?)' as const,
            consistency: 'snapshot_at_execution_start_merge_at_commit' as const,
            mergePolicy: 'conflict' as const,
            executionMode: args.storeMode,
          },
        }),
  };
}

export function buildPtcExecuteCodeGeulbatFacadeSource(args: {
  callbackConfig?: { socketPath: string; token: string };
  helpBundle: PtcExecuteCodeSdkHelpBundle;
}): string {
  const store = args.helpBundle.store;
  const serializedHelp = JSON.stringify({
    ...args.helpBundle,
    runtimeSdkProjection: undefined,
  });
  return [
    `const __geulbatHelp = Object.freeze(${serializedHelp});`,
    'function __geulbatClone(value) { return JSON.parse(JSON.stringify(value)); }',
    buildCallbackSource(args.callbackConfig),
    'const __geulbatTools = {};',
    'for (const tool of __geulbatHelp.callbacks.tools) { Object.defineProperty(__geulbatTools, tool.name, { enumerable: true, value: (args = {}) => __geulbatCallTool(tool.name, args) }); }',
    'for (const alias of __geulbatHelp.helpers.aliases) { Object.defineProperty(__geulbatTools, alias.alias, { enumerable: true, value: (args = {}) => __geulbatCallTool(alias.toolName, args) }); }',
    ...(store === undefined
      ? []
      : [
          buildStoreSource({
            callbackAvailable: args.callbackConfig !== undefined,
          }),
        ]),
    store === undefined
      ? 'const geulbat = Object.freeze({ sdkVersion: __geulbatHelp.protocolVersion, help: () => __geulbatClone(__geulbatHelp), callTool: __geulbatCallTool, tools: Object.freeze(__geulbatTools) });'
      : 'const geulbat = Object.freeze({ sdkVersion: __geulbatHelp.protocolVersion, help: () => __geulbatClone(__geulbatHelp), callTool: __geulbatCallTool, tools: Object.freeze(__geulbatTools), store: __geulbatStore });',
  ].join('\n');
}

export function buildPtcExecuteCodeReservedSdkRequireSource(
  helpBundle: PtcExecuteCodeSdkHelpBundle,
): string {
  const projection = helpBundle.runtimeSdkProjection;
  const importSpecifier =
    projection?.importSpecifier ??
    PTC_EXECUTE_CODE_RESERVED_SDK_IMPORT_SPECIFIER;
  const runtimeProjection =
    projection === undefined
      ? undefined
      : {
          sdkVersion: projection.sdkVersion,
          sdkProjectionHash: projection.sdkProjectionHash,
          policyId: projection.policyId,
          importSpecifier: projection.importSpecifier,
          manifestModule: projection.manifestModule,
          manifestSourceHash: projection.manifestSourceHash,
          containerRootPath: projection.mount.containerRootPath,
          modules: projection.modules.map((module) => ({
            specifier: module.specifier,
            exportName: module.exportName,
            modulePath: module.modulePath,
            sourceHash: module.sourceHash,
          })),
        };
  return [
    `const __geulbatSdkImportSpecifier = ${JSON.stringify(importSpecifier)};`,
    `const __geulbatSdkProjection = ${JSON.stringify(runtimeProjection)};`,
    'const __geulbatSdkModules = new Map();',
    'if (__geulbatSdkProjection !== undefined) {',
    "  const { createHash: __geulbatCreateHash } = require('node:crypto');",
    "  const { readFileSync: __geulbatReadFileSync } = require('node:fs');",
    "  const { resolve: __geulbatResolvePath, sep: __geulbatPathSeparator } = require('node:path');",
    '  const __geulbatSdkRoot = __geulbatResolvePath(__geulbatSdkProjection.containerRootPath);',
    '  const __geulbatResolveSdkFile = (modulePath) => {',
    '    const resolved = __geulbatResolvePath(__geulbatSdkRoot, ...modulePath.split("/"));',
    '    if (!resolved.startsWith(`${__geulbatSdkRoot}${__geulbatPathSeparator}`)) throw new Error("PTC SDK module path escaped the mounted projection");',
    '    return resolved;',
    '  };',
    '  const __geulbatManifestPath = __geulbatResolveSdkFile(__geulbatSdkProjection.manifestModule);',
    '  const __geulbatManifestSource = __geulbatReadFileSync(__geulbatManifestPath, "utf8");',
    '  const __geulbatManifestSourceHash = `sha256:${__geulbatCreateHash("sha256").update(__geulbatManifestSource, "utf8").digest("hex")}`;',
    '  if (__geulbatManifestSourceHash !== __geulbatSdkProjection.manifestSourceHash) throw new Error("PTC SDK mounted manifest does not match the pinned projection");',
    '  const __geulbatManifestNamespace = await import(`data:text/javascript;base64,${Buffer.from(__geulbatManifestSource, "utf8").toString("base64")}`);',
    '  if (__geulbatReadFileSync(__geulbatManifestPath, "utf8") !== __geulbatManifestSource) throw new Error("PTC SDK mounted manifest changed during import");',
    '  const __geulbatManifest = __geulbatManifestNamespace.projectionManifest;',
    '  if (__geulbatManifest === undefined || __geulbatManifest.sdkVersion !== __geulbatSdkProjection.sdkVersion || __geulbatManifest.sdkProjectionHash !== __geulbatSdkProjection.sdkProjectionHash || __geulbatManifest.policyId !== __geulbatSdkProjection.policyId || __geulbatManifest.importSpecifier !== __geulbatSdkProjection.importSpecifier) throw new Error("PTC SDK mounted manifest does not match the pinned projection");',
    '  for (const module of __geulbatSdkProjection.modules) {',
    '    const modulePath = __geulbatResolveSdkFile(module.modulePath);',
    '    const sourceBeforeImport = __geulbatReadFileSync(modulePath, "utf8");',
    '    const sourceHash = `sha256:${__geulbatCreateHash("sha256").update(sourceBeforeImport, "utf8").digest("hex")}`;',
    '    if (sourceHash !== module.sourceHash) throw new Error("PTC SDK mounted wrapper does not match the pinned projection");',
    '    const namespace = await import(`data:text/javascript;base64,${Buffer.from(sourceBeforeImport, "utf8").toString("base64")}`);',
    '    if (__geulbatReadFileSync(modulePath, "utf8") !== sourceBeforeImport) throw new Error("PTC SDK mounted wrapper changed during import");',
    '    const wrapper = namespace[module.exportName];',
    '    const bindRuntime = namespace.bindGeulbatRuntime;',
    "    if (typeof wrapper !== 'function') throw new Error('PTC SDK generated wrapper export is unavailable');",
    "    if (typeof bindRuntime !== 'function') throw new Error('PTC SDK generated wrapper runtime binder is unavailable');",
    '    bindRuntime(geulbat);',
    '    const sdkModule = (args = {}) => wrapper(args);',
    '    Object.defineProperties(sdkModule, {',
    '      sdkVersion: { enumerable: true, value: __geulbatSdkProjection.sdkVersion },',
    '      sdkProjectionHash: { enumerable: true, value: __geulbatSdkProjection.sdkProjectionHash },',
    '      [module.exportName]: { enumerable: true, value: sdkModule },',
    '    });',
    '    __geulbatSdkModules.set(module.specifier, Object.freeze(sdkModule));',
    '  }',
    '}',
    'function __geulbatCreateSdkModuleUnavailable(specifier) {',
    '  const error = new Error(`PTC SDK module ${specifier} is unavailable. Remediation: use a module listed by geulbat.help().sdkProjection.modules, or start a new exec after refreshing the pinned SDK projection.`);',
    "  error.name = 'PtcSdkModuleUnavailable';",
    "  error.errorCode = 'ptc_sdk_module_unavailable';",
    "  error.remediation = 'Use a listed SDK module or refresh the pinned SDK projection before retrying.';",
    '  return error;',
    '}',
    'function __geulbatLoadReservedModule(specifier, fallbackArgs) {',
    "  if (typeof specifier === 'string' && (specifier === __geulbatSdkImportSpecifier || specifier.startsWith(`${__geulbatSdkImportSpecifier}/`))) {",
    '    const sdkModule = __geulbatSdkModules.get(specifier);',
    '    if (sdkModule === undefined) throw __geulbatCreateSdkModuleUnavailable(specifier);',
    '    return sdkModule;',
    '  }',
    '  return Reflect.apply(require, undefined, fallbackArgs);',
    '}',
    'const __geulbatReservedRequire = new Proxy(require, {',
    '  apply(_target, _thisArg, args) { return __geulbatLoadReservedModule(args[0], args); },',
    "  get(target, property, receiver) { if (property === 'resolve') return (specifier, ...args) => (typeof specifier === 'string' && (specifier === __geulbatSdkImportSpecifier || specifier.startsWith(`${__geulbatSdkImportSpecifier}/`))) ? specifier : target.resolve(specifier, ...args); return Reflect.get(target, property, receiver); },",
    '});',
  ].join('\n');
}

function buildStoreSource(args: { callbackAvailable: boolean }): string {
  const shared = [
    'function __geulbatCreateStoreError(errorCode, message, remediation, details) {',
    '  const error = new Error(`${message} Remediation: ${remediation}`);',
    '  error.name = errorCode;',
    '  error.errorCode = errorCode;',
    '  error.remediation = remediation;',
    '  if (details !== undefined) error.details = details;',
    '  return error;',
    '}',
  ];
  if (!args.callbackAvailable) {
    return [
      ...shared,
      'async function __geulbatStoreTransportUnavailable() {',
      "  throw __geulbatCreateStoreError('StoreCallbackTransportUnavailable', 'PTC store callback transport is unavailable', 'Configure the PTC callback transport policy, then start a new exec.');",
      '}',
      'const __geulbatStore = Object.freeze({ get: __geulbatStoreTransportUnavailable, set: __geulbatStoreTransportUnavailable });',
    ].join('\n');
  }

  return [
    ...shared,
    'function __geulbatValidateStoreKey(key) {',
    "  if (typeof key !== 'string' || key.length === 0 || require('node:buffer').Buffer.byteLength(key, 'utf8') > 512) throw __geulbatCreateStoreError('StoreInvalidKey', 'PTC store keys must be non-empty strings of at most 512 UTF-8 bytes', 'Use a shorter non-empty string key and call geulbat.store again.');",
    '}',
    'function __geulbatFindNonJsonValue(value, ancestors) {',
    "  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;",
    "  if (typeof value === 'number') return !Number.isFinite(value) ? 'non-finite number' : (Object.is(value, -0) ? 'negative zero changes during JSON round-trip' : undefined);",
    "  if (typeof value !== 'object') return `unsupported ${typeof value}`;",
    "  if (ancestors.has(value)) return 'circular reference';",
    '  if (Array.isArray(value)) {',
    '    ancestors.add(value);',
    "    for (let index = 0; index < value.length; index += 1) { if (!Object.prototype.hasOwnProperty.call(value, index)) { ancestors.delete(value); return 'sparse array'; } const invalid = __geulbatFindNonJsonValue(value[index], ancestors); if (invalid !== undefined) { ancestors.delete(value); return invalid; } }",
    '    ancestors.delete(value);',
    '    return undefined;',
    '  }',
    '  const prototype = Object.getPrototypeOf(value);',
    "  if (prototype !== Object.prototype && prototype !== null) return 'non-plain object';",
    "  if (Object.getOwnPropertySymbols(value).length > 0) return 'symbol property';",
    "  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) return 'non-enumerable property';",
    '  ancestors.add(value);',
    '  for (const key of Object.keys(value)) { const invalid = __geulbatFindNonJsonValue(value[key], ancestors); if (invalid !== undefined) { ancestors.delete(value); return invalid; } }',
    '  ancestors.delete(value);',
    '  return undefined;',
    '}',
    'function __geulbatValidateStoreValue(value) {',
    "  let invalid; try { invalid = __geulbatFindNonJsonValue(value, new Set()); } catch { invalid = 'property access failed'; }",
    "  if (invalid !== undefined) throw __geulbatCreateStoreError('StoreValueNotSerializable', `The PTC store value is not JSON round-trip serializable (${invalid})`, 'Convert the value to finite JSON data and call geulbat.store.set again.');",
    '}',
    'function __geulbatValidateStoreOptions(options) {',
    '  if (options === undefined) return;',
    "  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'merge')) throw __geulbatCreateStoreError('StoreOptionsInvalid', 'PTC store set options are invalid', \"Use no options or pass only { merge: 'conflict' }.\");",
    "  if (options.merge !== undefined && options.merge !== 'conflict') throw __geulbatCreateStoreError('StoreMergePolicyUnsupported', 'The requested PTC store merge policy is not supported', \"Use the default conflict policy or pass { merge: 'conflict' }.\");",
    '}',
    'async function __geulbatCallStore(kind, args) {',
    '  const requestId = `ptc-store-${Date.now()}-${++__geulbatCallbackSequence}`;',
    "  const request = JSON.stringify({ requestId, token: __geulbatCallbackToken, kind, args }) + '\\n';",
    '  const socket = net.createConnection(__geulbatCallbackSocketPath);',
    '  try {',
    "    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });",
    '    socket.write(request);',
    '    const response = await __geulbatReadCallbackResponse(socket);',
    '    if (response && response.ok === true) return response.result;',
    "    throw __geulbatCreateStoreError((response && response.errorCode) || 'StoreCallbackFailed', (response && response.message) || 'PTC store callback failed', (response && response.remediation) || 'Start a new exec and retry only after checking the reported failure.', response && response.details);",
    '  } catch (error) {',
    '    socket.destroy();',
    '    throw error;',
    '  }',
    '}',
    'const __geulbatStore = Object.freeze({',
    "  get: async (key) => { __geulbatValidateStoreKey(key); return await __geulbatCallStore('store_get', { key }); },",
    "  set: async (key, value, options) => { __geulbatValidateStoreKey(key); __geulbatValidateStoreValue(value); __geulbatValidateStoreOptions(options); return await __geulbatCallStore('store_set', { key, value, ...(options === undefined ? {} : { options }) }); },",
    '});',
  ].join('\n');
}

function buildCallbackSource(
  callbackConfig: { socketPath: string; token: string } | undefined,
): string {
  if (callbackConfig === undefined) {
    return [
      'async function __geulbatCallTool() {',
      "  throw new Error('PTC execute_code tool callbacks are not enabled');",
      '}',
    ].join('\n');
  }

  return [
    "const net = require('node:net');",
    `const __geulbatCallbackSocketPath = ${JSON.stringify(callbackConfig.socketPath)};`,
    `const __geulbatCallbackToken = ${JSON.stringify(callbackConfig.token)};`,
    'let __geulbatCallbackSequence = 0;',
    'function __geulbatReadCallbackResponse(socket) {',
    '  return new Promise((resolve, reject) => {',
    "    socket.setEncoding('utf8');",
    "    let buffer = '';",
    '    let settled = false;',
    '    const finish = (fn) => {',
    '      if (settled) return;',
    '      settled = true;',
    "      socket.removeListener('data', onData);",
    "      socket.removeListener('error', onError);",
    "      socket.removeListener('end', onClose);",
    "      socket.removeListener('close', onClose);",
    '      fn();',
    '    };',
    "    const onClose = () => finish(() => reject(new Error('PTC callback response closed before a response was received')));",
    '    const onError = (error) => finish(() => reject(error));',
    '    const onData = (chunk) => {',
    '      buffer += chunk;',
    "      const newlineIndex = buffer.indexOf('\\n');",
    '      if (newlineIndex < 0) return;',
    '      const line = buffer.slice(0, newlineIndex);',
    "      finish(() => { try { resolve(JSON.parse(line)); } catch { reject(new Error('PTC callback response is invalid JSON')); } socket.destroy(); });",
    '    };',
    "    socket.on('data', onData);",
    "    socket.on('error', onError);",
    "    socket.on('end', onClose);",
    "    socket.on('close', onClose);",
    '  });',
    '}',
    'async function __geulbatCallTool(toolName, args = {}) {',
    "  if (typeof toolName !== 'string' || toolName.length === 0) throw new Error('toolName is required');",
    "  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool args must be an object');",
    '  const requestId = `ptc-tool-${Date.now()}-${++__geulbatCallbackSequence}`;',
    "  const request = JSON.stringify({ requestId, token: __geulbatCallbackToken, kind: 'geulbat_tool_call', args: { toolName, args } }) + '\\n';",
    '  const socket = net.createConnection(__geulbatCallbackSocketPath);',
    '  try {',
    "    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });",
    '    socket.write(request);',
    '    const response = await __geulbatReadCallbackResponse(socket);',
    '    if (response && response.ok === true) return response.result;',
    "    const error = new Error((response && response.message) || 'PTC tool callback failed');",
    "    error.errorCode = (response && response.errorCode) || 'ptc_tool_callback_failed';",
    '    throw error;',
    '  } catch (error) {',
    '    socket.destroy();',
    '    throw error;',
    '  }',
    '}',
  ].join('\n');
}
