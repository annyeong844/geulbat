import {
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeSdkHelpTool,
} from './execute-code-runtime-contract.js';

export { PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION };

export type PtcExecuteCodeSdkHelpTool = PtcExecuteCodeRuntimeSdkHelpTool;
export type PtcExecuteCodeSdkHelp = PtcExecuteCodeRuntimeSdkHelp;

export interface PtcExecuteCodeSdkHelpBundle {
  protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
  runtime: {
    language: 'javascript';
    executionSurface: 'node_via_lab_batch_command';
    sessionLifecycle: 'runtime_owned_reusable';
  };
  callbacks: {
    enabled: boolean;
    callShape: 'geulbat.callTool(name, args)';
    tools: readonly PtcExecuteCodeSdkHelpTool[];
  };
  helpers: {
    namespace: 'geulbat.tools';
    aliases: readonly PtcExecuteCodeSdkToolAlias[];
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
    { alias: 'webFetch', toolName: 'web_fetch' },
    { alias: 'agentWait', toolName: 'agent_wait' },
  ]);

export function buildPtcExecuteCodeSdkHelpBundle(args: {
  callbacksEnabled: boolean;
  sdkHelp: PtcExecuteCodeSdkHelp | undefined;
}): PtcExecuteCodeSdkHelpBundle {
  const tools = args.callbacksEnabled
    ? (args.sdkHelp?.callbackTools ?? [])
    : [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  return {
    protocolVersion: PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
    runtime: {
      language: 'javascript',
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
  };
}

export function buildPtcExecuteCodeGeulbatFacadeSource(args: {
  callbackConfig?: { socketPath: string; token: string };
  helpBundle: PtcExecuteCodeSdkHelpBundle;
}): string {
  return [
    `const __geulbatHelp = Object.freeze(${JSON.stringify(args.helpBundle)});`,
    'function __geulbatClone(value) { return JSON.parse(JSON.stringify(value)); }',
    buildCallbackSource(args.callbackConfig),
    'const __geulbatTools = {};',
    'for (const tool of __geulbatHelp.callbacks.tools) { Object.defineProperty(__geulbatTools, tool.name, { enumerable: true, value: (args = {}) => __geulbatCallTool(tool.name, args) }); }',
    'for (const alias of __geulbatHelp.helpers.aliases) { Object.defineProperty(__geulbatTools, alias.alias, { enumerable: true, value: (args = {}) => __geulbatCallTool(alias.toolName, args) }); }',
    'const geulbat = Object.freeze({ sdkVersion: __geulbatHelp.protocolVersion, help: () => __geulbatClone(__geulbatHelp), callTool: __geulbatCallTool, tools: Object.freeze(__geulbatTools) });',
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
    "    socket.on('data', (chunk) => {",
    '      buffer += chunk;',
    "      const newlineIndex = buffer.indexOf('\\n');",
    '      if (newlineIndex < 0) return;',
    '      const line = buffer.slice(0, newlineIndex);',
    "      try { resolve(JSON.parse(line)); } catch { reject(new Error('PTC callback response is invalid JSON')); }",
    '      socket.destroy();',
    '    });',
    "    socket.on('error', reject);",
    '  });',
    '}',
    'async function __geulbatCallTool(toolName, args = {}) {',
    "  if (typeof toolName !== 'string' || toolName.length === 0) throw new Error('toolName is required');",
    "  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool args must be an object');",
    '  const requestId = `ptc-tool-${Date.now()}-${++__geulbatCallbackSequence}`;',
    '  const socket = net.createConnection(__geulbatCallbackSocketPath);',
    "  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });",
    "  socket.write(JSON.stringify({ requestId, token: __geulbatCallbackToken, kind: 'geulbat_tool_call', args: { toolName, args } }) + '\\n');",
    '  const response = await __geulbatReadCallbackResponse(socket);',
    '  if (response && response.ok === true) return response.result;',
    "  const error = new Error((response && response.message) || 'PTC tool callback failed');",
    "  error.errorCode = (response && response.errorCode) || 'ptc_tool_callback_failed';",
    '  throw error;',
    '}',
  ].join('\n');
}
