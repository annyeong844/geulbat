import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { createDaemonHostCommandRuntime } from '../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../test-support/command-host-workspace.js';
import { WorkerStdioClientTransport } from './worker-stdio-client-transport.js';

// P7.6 M3 — 진짜 워커 프로세스로 배치를 증명한다.
//
// 인프로세스 코어로는 "데몬만 죽었다"를 흉내낼 수 없다: 코어가 데몬과 같은
// 프로세스에 있으면 데몬이 사라질 때 세션도 함께 사라지기 때문이다. 여기서만
// 실제 워커를 spawn하고, 파사드를 통째로 버린 뒤 새 파사드로 재입양한다.
//
// 창이 지나 회수되는 경로는 여기서 재지 않는다 — `worker-server.test.ts`가
// 창을 주입해 그 규칙을 이미 잠갔고, 같은 코드를 느린 하니스에서 다시 재는
// 것은 시간만 쓴다.

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

const server = new Server(
  { name: 'placement-e2e', version: '0.0.1' },
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

function daemonRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 64 * 1024, tailRingBytes: 64 * 1024 },
    requestedMode: 'worker',
  });
}

function firstTextContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const first = content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

async function callEcho(client: Client, text: string): Promise<string> {
  const result = await client.request(
    { method: 'tools/call', params: { name: 'echo', arguments: { text } } },
    CallToolResultSchema,
  );
  return firstTextContent(result.content);
}

void test('P7.6 M3: an MCP server survives the daemon that started it', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-e2e-'));
  const serverScript = join(stateRoot, 'echo-server.mjs');
  await writeFile(serverScript, echoServerSource(), 'utf8');
  t.after(async () => {
    await removeCommandHostWorkspace(stateRoot);
  });

  const launchSpec = {
    executable: process.execPath,
    args: [serverScript],
    cwd: stateRoot,
    env: { PATH: process.env['PATH'] ?? '' },
  };

  // ── 데몬 1: 서버를 세우고 대화한다 ────────────────────────────────
  const firstDaemon = daemonRuntime();
  const firstTransport = WorkerStdioClientTransport.launch(
    { hostCommands: firstDaemon, stateRoot, maxPageBytes: 32 * 1024 },
    launchSpec,
  );
  const firstClient = new Client({ name: 'daemon-1', version: '1' }, {});
  await firstClient.connect(firstTransport);
  assert.equal(await callEcho(firstClient, 'before'), 'echo:before');

  const session = firstTransport.session;
  assert.notEqual(session, undefined);
  if (session === undefined) {
    return;
  }

  // ── 데몬 1이 사라진다. 워커와 서버 프로세스는 남는다 ──────────────
  await firstTransport.detach();
  await firstDaemon.closeAll();

  // ── 데몬 2: 살아 있는 세션을 재입양한다 ──────────────────────────
  const secondDaemon = daemonRuntime();
  const secondTransport = WorkerStdioClientTransport.attach(
    { hostCommands: secondDaemon, stateRoot, maxPageBytes: 32 * 1024 },
    session,
  );
  const secondClient = new Client({ name: 'daemon-2', version: '1' }, {});
  await secondClient.connect(secondTransport);
  assert.equal(
    secondClient.getServerCapabilities(),
    undefined,
    'the re-adopted client skipped the handshake',
  );
  assert.equal(
    await callEcho(secondClient, 'after'),
    'echo:after',
    'the same server process answers the daemon that came back',
  );

  // ── 의도적 종료: 서버는 남지 않는다 ──────────────────────────────
  await secondTransport.close();
  const sessions = await secondDaemon.listThreadSessions({
    stateRoot,
    threadId: '',
  });
  assert.deepEqual(
    sessions,
    [],
    'a system session never appears in a thread enumeration',
  );
  await secondDaemon.closeAll();
});
