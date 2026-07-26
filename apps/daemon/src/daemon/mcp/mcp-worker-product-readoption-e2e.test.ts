import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isMcpServerRuntimeStatus } from '@geulbat/protocol/mcp';

import { createDaemonHostCommandRuntime } from '../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../test-support/command-host-workspace.js';
import { createDaemonRuntimeStateStore } from '../runtime-state-store.js';
import { executeTool } from '../tools/executor.js';
import { createToolRegistryStore } from '../tools/registry.js';
import { createGlobalMcpRuntime } from './global-mcp-runtime.js';

const DAEMON_FIXTURE_ARGUMENT = '--geulbat-mcp-readoption-daemon';
const FIXTURE_STATE_ROOT_ENV = 'GEULBAT_TEST_MCP_READOPTION_STATE_ROOT';
const FIXTURE_SERVER_SCRIPT_ENV = 'GEULBAT_TEST_MCP_READOPTION_SERVER_SCRIPT';
const FIXTURE_CALL_TEXT_ENV = 'GEULBAT_TEST_MCP_READOPTION_CALL_TEXT';
const FIXTURE_LAUNCH_ENV = 'GEULBAT_TEST_MCP_READOPTION_LAUNCH_ONLY';
const FIXTURE_READY_MESSAGE = 'geulbat-mcp-readoption-ready';

if (process.argv.includes(DAEMON_FIXTURE_ARGUMENT)) {
  await runDaemonFixture();
} else {
  void test(
    'P7.6 item 7: a second daemon process re-adopts the same live MCP server and intentional shutdown clears its coordinate',
    { timeout: 60_000 },
    async (t) => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-mcp-readoption-'),
      );
      const serverScript = join(stateRoot, 'echo-server.mjs');
      await writeFile(serverScript, echoServerSource(), 'utf8');
      let firstChild: ChildProcess | undefined;
      let secondChild: ChildProcess | undefined;

      t.after(async () => {
        stopChild(firstChild);
        stopChild(secondChild);
        const cleanupRuntime = createWorkerRuntime();
        await cleanupRuntime.closeAll().catch(() => undefined);
        await removeCommandHostWorkspace(stateRoot);
      });

      const first = await startDaemonFixture({
        stateRoot,
        serverScript,
        callText: 'before',
        launchEnvironment: 'present-for-the-first-daemon-only',
      });
      firstChild = first.child;
      const firstCall = parseEchoResult(first.ready.output);
      assert.equal(firstCall.text, 'before');
      assert.equal(firstCall.callCount, 1);
      assert.equal(first.ready.runtime.restartReason, undefined);

      first.child.kill('SIGKILL');
      await once(first.child, 'exit');

      const second = await startDaemonFixture({
        stateRoot,
        serverScript,
        callText: 'after',
      });
      secondChild = second.child;
      const secondCall = parseEchoResult(second.ready.output);
      assert.equal(secondCall.text, 'after');
      assert.equal(secondCall.callCount, 2);
      assert.equal(
        secondCall.pid,
        firstCall.pid,
        'the MCP server process survived daemon 1',
      );
      assert.equal(
        second.ready.outputRef,
        first.ready.outputRef,
        'daemon 2 attached to the persisted command-host session',
      );
      assert.equal(second.ready.runtime.state, 'ready');
      assert.equal(second.ready.runtime.restartReason, undefined);

      second.child.kill('SIGTERM');
      const [secondExitCode, secondExitSignal] = await once(
        second.child,
        'exit',
      );
      assert.equal(secondExitCode, 0);
      assert.equal(secondExitSignal, null);

      const stateStore = await createDaemonRuntimeStateStore({
        homeStateRoot: stateRoot,
      });
      try {
        assert.equal(
          stateStore.readMcpSessionCoordinate(second.ready.serverId),
          undefined,
          'intentional shutdown removes the re-adoption coordinate',
        );
      } finally {
        stateStore.close();
      }
    },
  );
}

interface DaemonFixtureReady {
  type: typeof FIXTURE_READY_MESSAGE;
  serverId: string;
  outputRef: string;
  output: string;
  runtime: {
    state: 'disabled' | 'connecting' | 'ready' | 'error';
    advertisedToolCount: number;
    availableToolNames: string[];
    activeToolNames: string[];
    error?: string;
    disabledReason?: 'server-disabled' | 'plugin-disabled';
    restartReason?: string;
  };
}

async function runDaemonFixture(): Promise<void> {
  const stateRoot = requireFixtureEnv(FIXTURE_STATE_ROOT_ENV);
  const serverScript = requireFixtureEnv(FIXTURE_SERVER_SCRIPT_ENV);
  const callText = requireFixtureEnv(FIXTURE_CALL_TEXT_ENV);
  const stateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const hostCommands = createWorkerRuntime();
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot: stateRoot,
    toolRegistry,
    hostCommands,
    maxPageBytes: 32 * 1024,
  });
  runtime.attachSessionCoordinateStore(stateStore);
  await runtime.initialize();

  let server = runtime.listServers()[0];
  if (server === undefined) {
    server = await runtime.addServer({
      name: 'Readoption echo server',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [serverScript],
        envKeys: [FIXTURE_LAUNCH_ENV],
      },
    });
    server = await runtime.installTool(server.serverId, 'echo');
  }
  const projectedName = toolRegistry
    .getAllRegisteredToolNames()
    .find((name) =>
      toolRegistry.getTool(name)?.description.includes('tool "echo"'),
    );
  if (projectedName === undefined) {
    throw new Error('re-adopted MCP echo tool was not projected');
  }
  const result = await executeTool(
    projectedName,
    { text: callText },
    {
      callId: `mcp-readoption-${callText}`,
      stateRoot,
      approvalGranted: true,
    },
    { toolRegistry },
  );
  if (!result.ok) {
    throw new Error(`MCP echo call failed: ${result.error}`);
  }
  const coordinate = stateStore.readMcpSessionCoordinate(server.serverId);
  if (coordinate === undefined) {
    throw new Error('MCP session coordinate was not persisted');
  }
  const shutdownSignal = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await sendFixtureMessage({
    type: FIXTURE_READY_MESSAGE,
    serverId: server.serverId,
    outputRef: coordinate.outputRef,
    output: result.output,
    runtime: server.runtime,
  });

  await shutdownSignal;
  try {
    await runtime.close();
    await hostCommands.closeAll();
  } finally {
    stateStore.close();
    if (process.connected) {
      process.disconnect();
    }
  }
}

function createWorkerRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 64 * 1024, tailRingBytes: 64 * 1024 },
    requestedMode: 'worker',
  });
}

async function startDaemonFixture(args: {
  stateRoot: string;
  serverScript: string;
  callText: string;
  launchEnvironment?: string;
}): Promise<{ child: ChildProcess; ready: DaemonFixtureReady }> {
  const childEnvironment = { ...process.env };
  delete childEnvironment[FIXTURE_LAUNCH_ENV];
  if (args.launchEnvironment !== undefined) {
    childEnvironment[FIXTURE_LAUNCH_ENV] = args.launchEnvironment;
  }
  const child = fork(
    fileURLToPath(import.meta.url),
    [DAEMON_FIXTURE_ARGUMENT],
    {
      env: {
        ...childEnvironment,
        [FIXTURE_STATE_ROOT_ENV]: args.stateRoot,
        [FIXTURE_SERVER_SCRIPT_ENV]: args.serverScript,
        [FIXTURE_CALL_TEXT_ENV]: args.callText,
      },
      execArgv: process.execArgv.filter(
        (argument) => !argument.startsWith('--test'),
      ),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome:
        | { ok: true; ready: DaemonFixtureReady }
        | { ok: false; error: Error },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (outcome.ok) {
        resolve({ child, ready: outcome.ready });
        return;
      }
      reject(outcome.error);
    };
    const onMessage = (message: unknown): void => {
      if (isDaemonFixtureReady(message)) {
        settle({ ok: true, ready: message });
      }
    };
    const onError = (error: Error): void => {
      settle({ ok: false, error });
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      settle({
        ok: false,
        error: new Error(
          `daemon fixture exited before readiness (code=${String(
            code,
          )}, signal=${String(signal)})`,
        ),
      });
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function isDaemonFixtureReady(value: unknown): value is DaemonFixtureReady {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== FIXTURE_READY_MESSAGE ||
    !('serverId' in value) ||
    typeof value.serverId !== 'string' ||
    !('outputRef' in value) ||
    typeof value.outputRef !== 'string' ||
    !('output' in value) ||
    typeof value.output !== 'string' ||
    !('runtime' in value) ||
    !isMcpServerRuntimeStatus(value.runtime)
  ) {
    return false;
  }
  return true;
}

async function sendFixtureMessage(message: DaemonFixtureReady): Promise<void> {
  const send = process.send;
  if (send === undefined) {
    throw new Error('MCP readoption fixture requires an IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    send.call(process, message, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function requireFixtureEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing MCP readoption fixture environment: ${name}`);
  }
  return value;
}

function parseEchoResult(output: string): {
  pid: number;
  callCount: number;
  text: string;
} {
  const match = /pid=(\d+);call=(\d+);text=([^"\\}]*)/u.exec(output);
  assert.ok(match);
  return {
    pid: Number(match[1]),
    callCount: Number(match[2]),
    text: match[3] ?? '',
  };
}

function stopChild(child: ChildProcess | undefined): void {
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill('SIGTERM');
  }
}

function echoServerSource(): string {
  const serverEntry = import.meta
    .resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioEntry = import.meta
    .resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesEntry = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
  return `
import { Server } from ${JSON.stringify(serverEntry)};
import { StdioServerTransport } from ${JSON.stringify(stdioEntry)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesEntry)};

let callCount = 0;
const server = new Server(
  { name: 'readoption-e2e', version: '0.0.1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'echoes with process identity',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (request) => {
  callCount += 1;
  return {
    content: [{
      type: 'text',
      text:
        'pid=' + process.pid +
        ';call=' + callCount +
        ';text=' + (request.params.arguments?.text ?? ''),
    }],
  };
});
await server.connect(new StdioServerTransport());
`;
}
