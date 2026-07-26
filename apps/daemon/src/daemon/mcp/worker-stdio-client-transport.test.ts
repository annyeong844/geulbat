import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createCommandSessionHost } from '../../command-host/session-core.js';
import { WorkerStdioClientTransport } from './worker-stdio-client-transport.js';

// P7.6 M2 — MCP 클라이언트가 "서버가 어디서 도는지" 모른 채 말한다. 여기서는
// 세션 코어가 프로세스를 소유하고, 전송은 바이트만 나른다.

// 서버는 tmpdir에서 도므로 SDK를 bare specifier로 찾을 수 없다 — 이 실행의
// 해석 결과를 그대로 심는다.
function buildServerSource(): string {
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
  { name: 'placement-probe', version: '0.0.1' },
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

interface Fixture {
  host: ReturnType<typeof createCommandSessionHost>;
  stateRoot: string;
  serverPath: string;
}

async function makeFixture(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-placement-'));
  const serverPath = join(stateRoot, 'placement-probe-server.mjs');
  await writeFile(serverPath, buildServerSource(), 'utf8');
  const host = createCommandSessionHost({
    inlineMaxBytes: 64 * 1024,
    tailRingBytes: 64 * 1024,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot, serverPath };
}

function firstTextContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const first = content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

function transportOptions(fixture: Fixture) {
  return {
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    maxPageBytes: 32 * 1024,
  };
}

function launchSpec(fixture: Fixture) {
  return {
    executable: process.execPath,
    args: [fixture.serverPath],
    cwd: fixture.stateRoot,
    env: { PATH: process.env['PATH'] ?? '' },
  };
}

void test('P7.6 M2: an MCP client talks to a server it never spawned', async (t) => {
  const fixture = await makeFixture(t);
  const transport = WorkerStdioClientTransport.launch(
    transportOptions(fixture),
    launchSpec(fixture),
  );
  const client = new Client({ name: 'geulbat-test', version: '1' }, {});
  await client.connect(transport);
  t.after(async () => {
    await transport.close().catch(() => undefined);
  });

  const listed = await client.request(
    { method: 'tools/list' },
    ListToolsResultSchema,
  );
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ['echo'],
  );

  const called = await client.request(
    {
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'through the session' } },
    },
    CallToolResultSchema,
  );
  assert.equal(firstTextContent(called.content), 'echo:through the session');
});

void test('P7.6 M2: a new client re-adopts the surviving session', async (t) => {
  const fixture = await makeFixture(t);
  const first = WorkerStdioClientTransport.launch(
    transportOptions(fixture),
    launchSpec(fixture),
  );
  const firstClient = new Client({ name: 'daemon-before', version: '1' }, {});
  await firstClient.connect(first);
  await firstClient.request({ method: 'tools/list' }, ListToolsResultSchema);

  // 데몬만 죽는다: 클라이언트는 떠나고 세션(프로세스)은 남는다.
  const session = first.session;
  assert.notEqual(session, undefined);
  if (session === undefined) {
    return;
  }
  await first.detach();

  const resumed = WorkerStdioClientTransport.attach(
    transportOptions(fixture),
    session,
  );
  const resumedClient = new Client({ name: 'daemon-after', version: '1' }, {});
  await resumedClient.connect(resumed);
  t.after(async () => {
    await resumed.close().catch(() => undefined);
  });
  assert.equal(
    resumedClient.getServerCapabilities(),
    undefined,
    'the resumed client skipped the handshake',
  );

  const called = await resumedClient.request(
    {
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'after restart' } },
    },
    CallToolResultSchema,
  );
  assert.equal(
    firstTextContent(called.content),
    'echo:after restart',
    'the surviving server answers the re-adopted client',
  );
});
