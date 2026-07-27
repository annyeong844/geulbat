import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isProcessAlive } from '../../command-host/runtime-paths.js';
import { createCommandSessionHost } from '../../command-host/session-core.js';
import { executeTool } from '../tools/executor.js';
import { createToolRegistryStore } from '../tools/registry.js';
import {
  createGlobalMcpRuntime,
  retiredMcpPlacementEnvDiagnostic,
} from './global-mcp-runtime.js';

// P7.6 M4 — MCP 서버 프로세스의 소유자는 command-host 세션 하나다. 데몬의
// 자식으로 두는 갈래가 사라졌으므로 두 배치를 비교할 대상이 없다. 남은 계약은
// ① 도구가 세션 너머에서도 똑같이 답한다 ② 의도 있는 종료가 세션을 남기지
// 않는다 ③ 사라진 옵트아웃이 조용히 무시되지 않는다.

function echoServerSource(
  options: { descendantPidPath?: string } = {},
): string {
  const serverEntry = import.meta
    .resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioEntry = import.meta
    .resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesEntry = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
  const descendantSource =
    options.descendantPidPath === undefined
      ? ''
      : `
import { spawn } from 'node:child_process';

const descendant = spawn(
  process.execPath,
  [
    '-e',
    ${JSON.stringify(`
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => undefined);
writeFileSync(${JSON.stringify(options.descendantPidPath)}, String(process.pid));
setInterval(() => undefined, 1000);
`)},
  ],
  { stdio: 'ignore' },
);
descendant.unref();
`;
  return `
import { Server } from ${JSON.stringify(serverEntry)};
import { StdioServerTransport } from ${JSON.stringify(stdioEntry)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesEntry)};
${descendantSource}

const server = new Server(
  { name: 'placement-equivalence', version: '0.0.1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'echoes back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [{ type: 'text', text: 'echo:' + (request.params.arguments?.text ?? '') }],
}));
await server.connect(new StdioServerTransport());
`;
}

function attachInMemorySessionCoordinateStore(
  runtime: ReturnType<typeof createGlobalMcpRuntime>,
): void {
  const outputRefs = new Map<string, string>();
  runtime.attachSessionCoordinateStore({
    readMcpSessionCoordinate(serverId) {
      const outputRef = outputRefs.get(serverId);
      return outputRef === undefined ? undefined : { serverId, outputRef };
    },
    persistMcpSessionCoordinate({ serverId, outputRef }) {
      outputRefs.set(serverId, outputRef);
    },
    deleteMcpSessionCoordinate(serverId) {
      outputRefs.delete(serverId);
    },
  });
}

void test('P7.6 M4: the retired local opt-out is reported instead of silently ignored', () => {
  // `local`은 M3의 한 줄 옵트아웃이었고 M4에서 사라졌다. 남은 값이 조용히
  // 무시되면 사용자는 데몬이 아직 프로세스를 든다고 믿는다.
  assert.equal(retiredMcpPlacementEnvDiagnostic({}), undefined);
  assert.equal(
    retiredMcpPlacementEnvDiagnostic({ GEULBAT_MCP_PLACEMENT: '' }),
    undefined,
  );
  const diagnostic = retiredMcpPlacementEnvDiagnostic({
    GEULBAT_MCP_PLACEMENT: 'local',
  });
  assert.match(diagnostic ?? '', /GEULBAT_MCP_PLACEMENT=local/u);
  assert.match(diagnostic ?? '', /no longer honored/u);
  // 옛 기본값을 그대로 둔 환경도 같은 진단을 받는다 — 이제 설정 자체가 없다.
  assert.notEqual(
    retiredMcpPlacementEnvDiagnostic({ GEULBAT_MCP_PLACEMENT: 'worker' }),
    undefined,
  );
});

void test('P7.6: an installed MCP tool answers through a command-host session', async (t) => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-worker-'));
  const serverScript = join(homeStateRoot, 'echo-server.mjs');
  await writeFile(serverScript, echoServerSource(), 'utf8');
  const host = createCommandSessionHost({
    inlineMaxBytes: 64 * 1024,
    tailRingBytes: 64 * 1024,
  });
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry,
    hostCommands: host,
    maxPageBytes: 32 * 1024,
  });
  attachInMemorySessionCoordinateStore(runtime);
  t.after(async () => {
    await runtime.close();
    await host.closeAll();
    await rm(homeStateRoot, { recursive: true, force: true });
  });

  await runtime.initialize();
  const added = await runtime.addServer({
    name: 'Echo server',
    transport: {
      kind: 'stdio',
      command: process.execPath,
      args: [serverScript],
      envKeys: [],
    },
  });
  assert.equal(added.runtime.state, 'ready');
  assert.deepEqual(added.runtime.availableToolNames, ['echo']);

  const installed = await runtime.installTool(added.serverId, 'echo');
  assert.deepEqual(installed.runtime.activeToolNames, ['echo']);

  // 서버 프로세스는 데몬의 자식이 아니라 세션이다 — 도구가 답하는 동안
  // 세션이 살아 있다는 것이 배치의 관측 가능한 증거다.
  assert.equal(
    host.listSessions().filter((session) => session.running).length,
    1,
  );

  // 투영 이름은 해시라 이름으로 찾을 수 없다 — 설명이 원래 도구를 말한다.
  const projectedName = toolRegistry
    .getAllRegisteredToolNames()
    .find((name) =>
      toolRegistry.getTool(name)?.description.includes('tool "echo"'),
    );
  assert.notEqual(projectedName, undefined);
  if (projectedName === undefined) {
    return;
  }

  const result = await executeTool(
    projectedName,
    { text: 'via session' },
    {
      callId: 'call-placement',
      stateRoot: homeStateRoot,
      approvalGranted: true,
    },
    { toolRegistry },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.match(result.output, /echo:via session/u);
  }
});

void test('P7.6: closing the MCP runtime leaves no worker session behind', async (t) => {
  // 오너 결정(§7.1): 글밭을 끄면 MCP도 꺼진다. 정상 종료 경로는
  // globalMcp.close() → transport.close() → 세션 terminate로 이어진다.
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-orphan-'));
  const serverScript = join(homeStateRoot, 'echo-server.mjs');
  await writeFile(serverScript, echoServerSource(), 'utf8');
  const host = createCommandSessionHost({
    inlineMaxBytes: 64 * 1024,
    tailRingBytes: 64 * 1024,
  });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
    hostCommands: host,
    maxPageBytes: 32 * 1024,
  });
  attachInMemorySessionCoordinateStore(runtime);
  t.after(async () => {
    await host.closeAll();
    await rm(homeStateRoot, { recursive: true, force: true });
  });

  await runtime.initialize();
  await runtime.addServer({
    name: 'Echo server',
    transport: {
      kind: 'stdio',
      command: process.execPath,
      args: [serverScript],
      envKeys: [],
    },
  });
  assert.equal(
    host.listSessions().filter((session) => session.running).length,
    1,
    'the server runs as a live session while the runtime is up',
  );

  await runtime.close();

  // 종료는 SIGTERM → 유예 → SIGKILL이므로 즉시가 아니라 유계다. 남는지가
  // 문제이지 언제 죽는지가 아니므로, 정착까지 기다렸다 확인한다.
  let survivors = host.listSessions().filter((session) => session.running);
  for (let attempt = 0; attempt < 100 && survivors.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    survivors = host.listSessions().filter((session) => session.running);
  }
  assert.deepEqual(
    survivors.map((session) => session.command),
    [],
    'no MCP process outlives an intentional shutdown',
  );
});

void test(
  'P7.6: closing the MCP runtime reaps a SIGTERM-resistant descendant',
  { skip: process.platform === 'win32' },
  async (t) => {
    const homeStateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-mcp-descendant-'),
    );
    const serverScript = join(homeStateRoot, 'echo-server.mjs');
    const descendantPidPath = join(homeStateRoot, 'descendant.pid');
    await writeFile(
      serverScript,
      echoServerSource({ descendantPidPath }),
      'utf8',
    );
    const host = createCommandSessionHost({
      inlineMaxBytes: 64 * 1024,
      tailRingBytes: 64 * 1024,
    });
    const runtime = createGlobalMcpRuntime({
      homeStateRoot,
      toolRegistry: createToolRegistryStore({ builtins: [] }),
      hostCommands: host,
      maxPageBytes: 32 * 1024,
    });
    attachInMemorySessionCoordinateStore(runtime);
    let descendantPid: number | undefined;
    t.after(async () => {
      await runtime.close().catch(() => undefined);
      if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
      await host.closeAll();
      await rm(homeStateRoot, { recursive: true, force: true });
    });

    await runtime.initialize();
    await runtime.addServer({
      name: 'Echo server with descendant',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [serverScript],
        envKeys: [],
      },
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(
      descendantPid !== undefined && Number.isSafeInteger(descendantPid),
      'the MCP fixture publishes its descendant pid',
    );
    assert.equal(isProcessAlive(descendantPid), true);

    await runtime.close();

    for (
      let attempt = 0;
      attempt < 100 && isProcessAlive(descendantPid);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      isProcessAlive(descendantPid),
      false,
      'no SIGTERM-resistant MCP descendant outlives shutdown',
    );
  },
);
