import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { executeTool } from '../tools/executor.js';
import { createToolRegistryStore } from '../tools/registry.js';
import {
  McpServerConfigError,
  McpServerNotFoundError,
  McpServerOwnershipError,
} from './global-mcp-contract.js';
import type { PluginMcpServerBinding } from './global-mcp-registration.js';
import { createGlobalMcpRuntime } from './global-mcp-runtime.js';

const require = createRequire(import.meta.url);

// Full-suite runs on the mounted WSL checkout have measured SDK child startup
// beyond five seconds. This is only the failure bound for the real two-process
// concurrency gate below; successful startup still completes immediately.
const MCP_CONCURRENT_STARTUP_TEST_TIMEOUT_MS = 30_000;

void test('global MCP keeps discovery lightweight and persists only explicitly installed schemas', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-home-'));
  const serverScript = join(homeStateRoot, 'echo-mcp-server.mjs');
  await writeFile(serverScript, createEchoMcpServerSource(), 'utf8');
  const firstRegistry = createToolRegistryStore({ builtins: [] });
  const firstRuntime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: firstRegistry,
  });

  try {
    await firstRuntime.initialize();
    const added = await firstRuntime.addServer({
      name: 'Echo server',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [serverScript],
        envKeys: [],
      },
    });

    assert.equal(added.runtime.state, 'ready');
    assert.equal(added.runtime.advertisedToolCount, 9);
    assert.deepEqual(added.runtime.availableToolNames, [
      'broken_output_schema',
      'broken_schema',
      'echo',
      'invalid_ref_schema',
      'recursive_schema',
      'remote_schema',
      'required_task',
      'schema_echo',
    ]);
    assert.deepEqual(added.runtime.activeToolNames, []);
    assert.deepEqual(added.installedToolNames, []);
    assert.deepEqual(firstRegistry.getAllRegisteredToolNames(), []);
    assert.equal(
      findProjectedToolName(firstRegistry, 'app_only_refresh'),
      undefined,
    );
    await assert.rejects(
      firstRuntime.installTool(added.serverId, 'app_only_refresh'),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /does not advertise a model-visible tool/u.test(error.message),
    );
    await assert.rejects(
      firstRuntime.installTool(added.serverId, 'broken_schema'),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /invalid input schema/u.test(error.message),
    );
    await assert.rejects(
      firstRuntime.installTool(added.serverId, 'broken_output_schema'),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /invalid output schema/u.test(error.message),
    );
    await assert.rejects(
      firstRuntime.installTool(added.serverId, 'required_task'),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /requires task-based execution/u.test(error.message),
    );
    for (const toolName of [
      'invalid_ref_schema',
      'recursive_schema',
      'remote_schema',
    ]) {
      await assert.rejects(
        firstRuntime.installTool(added.serverId, toolName),
        (error: unknown) =>
          error instanceof McpServerConfigError &&
          /invalid input schema/u.test(error.message),
      );
    }
    assert.deepEqual(firstRegistry.getAllRegisteredToolNames(), []);

    const echoInstalled = await firstRuntime.installTool(
      added.serverId,
      'echo',
    );
    assert.deepEqual(echoInstalled.installedToolNames, ['echo']);
    assert.deepEqual(echoInstalled.runtime.activeToolNames, ['echo']);
    const projectedName = findProjectedToolName(firstRegistry, 'echo');
    assert.ok(projectedName);
    assert.match(projectedName, /^mcp_[A-Za-z0-9_-]+$/u);
    assert.ok(projectedName.length <= 64);
    assert.deepEqual(firstRegistry.getToolMeta(projectedName), {
      sideEffectLevel: 'write',
      mayMutateComputerFiles: true,
      requiresApproval: true,
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        approvalRequired: true,
        effectClass: 'hostStateMutation',
      },
    });
    assert.deepEqual(
      firstRegistry.getTool(projectedName)?.catalogSearchMetadata,
      {
        family: 'catalog',
        searchHints: ['mcp external tool', 'Echo server', 'echo'],
        tags: ['external-tool', 'mcp'],
        whenToUse: 'Use the configured MCP tool "echo" from "Echo server".',
        notFor:
          'Calls that do not require this configured external MCP server.',
      },
    );

    const blocked = await executeTool(
      projectedName,
      { text: 'hello' },
      {
        callId: 'mcp-call-blocked',
        stateRoot: homeStateRoot,
        approvalGranted: false,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, 'approval_required');

    const called = await executeTool(
      projectedName,
      { text: 'hello' },
      {
        callId: 'mcp-call-approved',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(called.ok, true);
    assert.match(called.output, /echo:hello/u);
    const invalidObjectCall = await executeTool(
      projectedName,
      [],
      {
        callId: 'mcp-call-invalid-object',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(invalidObjectCall.ok, false);
    assert.equal(invalidObjectCall.errorCode, 'invalid_args');
    const serverErrorCall = await executeTool(
      projectedName,
      { text: 'server-error' },
      {
        callId: 'mcp-call-server-error',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(serverErrorCall.ok, false);
    assert.equal(serverErrorCall.errorCode, 'execution_failed');
    const thrownCall = await executeTool(
      projectedName,
      { text: 'throw' },
      {
        callId: 'mcp-call-thrown',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(thrownCall.ok, false);
    assert.equal(thrownCall.errorCode, 'execution_failed');

    const schemaInstalled = await firstRuntime.installTool(
      added.serverId,
      'schema_echo',
    );
    assert.deepEqual(schemaInstalled.installedToolNames, [
      'echo',
      'schema_echo',
    ]);
    const persistedRegistry = await readFile(
      join(homeStateRoot, '.geulbat', 'mcp-servers.json'),
      'utf8',
    );
    assert.match(persistedRegistry, /"installedToolNames"/u);
    assert.doesNotMatch(persistedRegistry, /inputSchema|Echo a test value/u);
    const schemaToolName = findProjectedToolName(firstRegistry, 'schema_echo');
    assert.ok(schemaToolName);
    const schemaTool = firstRegistry.getTool(schemaToolName);
    assert.ok(schemaTool);
    assert.ok('type' in schemaTool.parameters);
    assert.deepEqual(schemaTool.parameters.properties['payload'], {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    });
    const invalidSchemaCall = await executeTool(
      schemaToolName,
      { payload: { text: 42 } },
      {
        callId: 'mcp-call-schema-invalid',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(invalidSchemaCall.ok, false);
    assert.equal(invalidSchemaCall.errorCode, 'invalid_args');
    const validSchemaCall = await executeTool(
      schemaToolName,
      { payload: { text: 'schema hello' } },
      {
        callId: 'mcp-call-schema-valid',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(validSchemaCall.ok, true);
    assert.match(validSchemaCall.output, /echo:schema hello/u);
    const invalidOutputCall = await executeTool(
      schemaToolName,
      { payload: { text: 'invalid-output' } },
      {
        callId: 'mcp-call-output-schema-invalid',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(invalidOutputCall.ok, false);
    assert.equal(invalidOutputCall.errorCode, 'execution_failed');
    const missingOutputCall = await executeTool(
      schemaToolName,
      { payload: { text: 'missing-output' } },
      {
        callId: 'mcp-call-output-schema-missing',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(missingOutputCall.ok, false);
    assert.equal(missingOutputCall.errorCode, 'execution_failed');

    const echoRemoved = await firstRuntime.uninstallTool(
      added.serverId,
      'echo',
    );
    assert.deepEqual(echoRemoved.installedToolNames, ['schema_echo']);
    assert.deepEqual(echoRemoved.runtime.activeToolNames, ['schema_echo']);
    assert.equal(firstRegistry.getTool(projectedName), undefined);
    const removedCall = await executeTool(
      projectedName,
      { text: 'after removal' },
      {
        callId: 'mcp-call-after-removal',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: firstRegistry },
    );
    assert.equal(removedCall.ok, false);
    assert.equal(removedCall.errorCode, 'unknown_tool');

    const disabled = await firstRuntime.setServerEnabled(added.serverId, false);
    assert.equal(disabled.runtime.state, 'disabled');
    assert.equal(firstRegistry.getTool(projectedName), undefined);
    assert.equal(firstRegistry.getTool(schemaToolName), undefined);
    await firstRuntime.close();

    const secondRegistry = createToolRegistryStore({ builtins: [] });
    const secondRuntime = createGlobalMcpRuntime({
      homeStateRoot,
      toolRegistry: secondRegistry,
    });
    await secondRuntime.initialize();
    assert.equal(secondRuntime.listServers()[0]?.runtime.state, 'disabled');

    const enabled = await secondRuntime.setServerEnabled(added.serverId, true);
    assert.equal(enabled.runtime.state, 'ready');
    assert.deepEqual(enabled.installedToolNames, ['schema_echo']);
    assert.deepEqual(enabled.runtime.activeToolNames, ['schema_echo']);
    assert.equal(secondRegistry.getAllRegisteredToolNames().length, 1);

    await secondRuntime.removeServer(added.serverId);
    assert.deepEqual(secondRuntime.listServers(), []);
    assert.deepEqual(secondRegistry.getAllRegisteredToolNames(), []);
    await secondRuntime.close();
  } finally {
    await firstRuntime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP rejects a repeated tools/list cursor instead of polling forever', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-cursor-'));
  const serverScript = join(homeStateRoot, 'cursor-loop-mcp-server.mjs');
  await writeFile(serverScript, createCursorLoopMcpServerSource(), 'utf8');
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });

  try {
    await runtime.initialize();
    const added = await runtime.addServer({
      name: 'Cursor loop server',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [serverScript],
        envKeys: [],
      },
    });

    assert.equal(added.runtime.state, 'error');
    assert.match(added.runtime.error ?? '', /repeated a pagination cursor/u);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP persists environment key references without secret values', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-env-'));
  const registry = createToolRegistryStore({ builtins: [] });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: registry,
  });
  const key = 'GEULBAT_TEST_MCP_SECRET';
  const secret = 'must-not-be-persisted';
  process.env[key] = secret;

  try {
    await runtime.initialize();
    await runtime.addServer({
      name: 'Disabled secret-ref server',
      enabled: false,
      transport: {
        kind: 'stdio',
        command: 'unused-command',
        args: [],
        envKeys: [key],
      },
    });
    const persisted = await readFile(
      join(homeStateRoot, '.geulbat', 'mcp-servers.json'),
      'utf8',
    );
    assert.match(persisted, new RegExp(key, 'u'));
    assert.doesNotMatch(persisted, new RegExp(secret, 'u'));
  } finally {
    delete process.env[key];
    await runtime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('plugin MCP bindings preserve per-server preference while package eligibility controls the existing runtime', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-plugin-mcp-'));
  const pluginRoot = join(homeStateRoot, 'managed-plugin');
  const serverScript = join(pluginRoot, 'echo-mcp-server.mjs');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(serverScript, createEchoMcpServerSource(), 'utf8');
  const registry = createToolRegistryStore({ builtins: [] });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: registry,
  });
  const source = {
    kind: 'plugin' as const,
    installationId: '11111111-1111-4111-8111-111111111111',
    name: 'echo-plugin',
    displayName: 'Echo Plugin',
    version: '1.0.0',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    serverName: 'echo',
  };
  const binding = (pluginEnabled: boolean): PluginMcpServerBinding => ({
    name: 'Echo Plugin · echo',
    pluginEnabled,
    source,
    transport: {
      kind: 'stdio',
      command: process.execPath,
      args: ['echo-mcp-server.mjs'],
      envKeys: [],
    },
    async resolveLaunch() {
      return { cwd: pluginRoot };
    },
  });

  try {
    await runtime.initialize([binding(false)]);
    const installed = runtime.listServers()[0];
    assert.ok(installed);
    assert.equal(installed.enabled, false);
    assert.deepEqual(installed.runtime, {
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
      disabledReason: 'server-disabled',
    });
    assert.equal(JSON.stringify(installed).includes(pluginRoot), false);

    const preferred = await runtime.setServerEnabled(installed.serverId, true);
    assert.equal(preferred.enabled, true);
    assert.equal(preferred.runtime.disabledReason, 'plugin-disabled');
    assert.deepEqual(registry.getAllRegisteredToolNames(), []);

    await runtime.reconcilePluginServers([binding(true)]);
    const ready = runtime.listServers()[0];
    assert.equal(ready?.serverId, installed.serverId);
    assert.equal(ready?.runtime.state, 'ready');
    assert.deepEqual(registry.getAllRegisteredToolNames(), []);
    await runtime.installTool(installed.serverId, 'echo');
    const projectedName = findProjectedToolName(registry, 'echo');
    assert.ok(projectedName);
    assert.deepEqual(
      (await runtime.installTool(installed.serverId, 'echo'))
        .installedToolNames,
      ['echo'],
    );
    const called = await executeTool(
      projectedName,
      { text: 'plugin hello' },
      {
        callId: 'plugin-mcp-call',
        stateRoot: homeStateRoot,
        approvalGranted: true,
      },
      { toolRegistry: registry },
    );
    assert.equal(called.ok, true);
    const output = JSON.parse(called.output) as {
      mcp?: { source?: { kind?: string; installationId?: string } };
      result?: unknown;
    };
    assert.deepEqual(output.mcp?.source, source);
    assert.ok(output.result);
    assert.equal(called.output.includes(pluginRoot), false);

    await runtime.reconcilePluginServers([binding(false)]);
    assert.equal(
      runtime.listServers()[0]?.runtime.disabledReason,
      'plugin-disabled',
    );
    assert.deepEqual(registry.getAllRegisteredToolNames(), []);
    await runtime.reconcilePluginServers([binding(true)]);
    assert.equal(runtime.listServers()[0]?.runtime.state, 'ready');
    assert.deepEqual(runtime.listServers()[0]?.installedToolNames, ['echo']);
    assert.ok(findProjectedToolName(registry, 'echo'));

    await runtime.suspendPluginServers(source.installationId);
    const suspended = runtime.listServers()[0];
    assert.equal(suspended?.enabled, true);
    assert.equal(suspended?.runtime.disabledReason, 'plugin-disabled');
    assert.deepEqual(registry.getAllRegisteredToolNames(), []);

    await runtime.reconcilePluginServers([binding(true)]);
    assert.equal(runtime.listServers()[0]?.runtime.state, 'ready');
    assert.deepEqual(runtime.listServers()[0]?.installedToolNames, ['echo']);
    assert.ok(findProjectedToolName(registry, 'echo'));
    await assert.rejects(
      runtime.removeServer(installed.serverId),
      (error: unknown) => error instanceof McpServerOwnershipError,
    );
    await runtime.removePluginServers(source.installationId);
    assert.deepEqual(runtime.listServers(), []);
    assert.deepEqual(registry.getAllRegisteredToolNames(), []);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP migrates legacy manual registrations once and can reload the migrated registry', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-migration-'));
  const registryRoot = join(homeStateRoot, '.geulbat');
  const registryPath = join(registryRoot, 'mcp-servers.json');
  await mkdir(registryRoot, { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          configVersion: 1,
          serverId: 'legacy-manual-server',
          name: 'Legacy manual server',
          enabled: false,
          transport: {
            kind: 'stdio',
            command: 'node',
            args: [],
            envKeys: [],
          },
        },
      ],
    })}\n`,
    'utf8',
  );
  const firstRuntime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  let secondRuntime: ReturnType<typeof createGlobalMcpRuntime> | undefined;

  try {
    await firstRuntime.initialize();
    const migrated = JSON.parse(await readFile(registryPath, 'utf8')) as {
      schemaVersion?: number;
      servers?: Array<{
        configVersion?: number;
        installedToolNames?: unknown;
        source?: unknown;
      }>;
    };
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.servers?.[0]?.configVersion, 3);
    assert.deepEqual(migrated.servers?.[0]?.installedToolNames, []);
    assert.deepEqual(migrated.servers?.[0]?.source, { kind: 'manual' });
    await firstRuntime.close();

    secondRuntime = createGlobalMcpRuntime({
      homeStateRoot,
      toolRegistry: createToolRegistryStore({ builtins: [] }),
    });
    await secondRuntime.initialize();
    assert.equal(secondRuntime.listServers()[0]?.source.kind, 'manual');
  } finally {
    await firstRuntime.close().catch(() => undefined);
    await secondRuntime?.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP rejects a persisted manual registration that collides with a plugin identity during initialization', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-conflict-'));
  const source = {
    kind: 'plugin' as const,
    installationId: '22222222-2222-4222-8222-222222222222',
    name: 'conflict-plugin',
    displayName: 'Conflict Plugin',
    version: '1.0.0',
    contentDigest: `sha256:${'b'.repeat(64)}`,
    serverName: 'conflict',
  };
  const binding: PluginMcpServerBinding = {
    name: 'Conflict Plugin · conflict',
    pluginEnabled: false,
    source,
    transport: {
      kind: 'stdio',
      command: 'node',
      args: [],
      envKeys: [],
    },
    async resolveLaunch() {
      return { cwd: homeStateRoot };
    },
  };
  const firstRuntime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  let secondRuntime: ReturnType<typeof createGlobalMcpRuntime> | undefined;

  try {
    await firstRuntime.initialize([binding]);
    const pluginServerId = firstRuntime.listServers()[0]?.serverId;
    assert.ok(pluginServerId);
    await firstRuntime.close();
    await writeFile(
      join(homeStateRoot, '.geulbat', 'mcp-servers.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        servers: [
          {
            configVersion: 1,
            serverId: pluginServerId,
            name: 'Manual collision',
            enabled: false,
            source: { kind: 'manual' },
            transport: {
              kind: 'stdio',
              command: 'node',
              args: [],
              envKeys: [],
            },
          },
        ],
      })}\n`,
      'utf8',
    );

    secondRuntime = createGlobalMcpRuntime({
      homeStateRoot,
      toolRegistry: createToolRegistryStore({ builtins: [] }),
    });
    await assert.rejects(
      secondRuntime.initialize([binding]),
      /conflicts with a manual registration/u,
    );
  } finally {
    await firstRuntime.close().catch(() => undefined);
    await secondRuntime?.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP refuses unknown persisted fields instead of accepting embedded secrets', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-invalid-'));
  const registryPath = join(homeStateRoot, '.geulbat', 'mcp-servers.json');
  await mkdir(join(homeStateRoot, '.geulbat'), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          configVersion: 1,
          serverId: 'server-one',
          name: 'Unsafe config',
          enabled: false,
          transport: {
            kind: 'stdio',
            command: 'node',
            args: [],
            envKeys: [],
            secretValue: 'must-be-rejected',
          },
        },
      ],
    }),
    { encoding: 'utf8', flag: 'w' },
  );
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });

  try {
    await assert.rejects(
      runtime.initialize(),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /invalid shape/u.test(error.message),
    );
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP isolates invalid environment references and starts enabled servers concurrently', async () => {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mcp-startup-'));
  const markerDir = join(homeStateRoot, 'startup-markers');
  const serverScript = join(homeStateRoot, 'gated-echo-mcp-server.mjs');
  const registryDir = join(homeStateRoot, '.geulbat');
  const missingEnvironmentKey = 'GEULBAT_TEST_MCP_MISSING_ENV';
  delete process.env[missingEnvironmentKey];
  await mkdir(markerDir, { recursive: true });
  await mkdir(registryDir, { recursive: true });
  await writeFile(serverScript, createEchoMcpServerSource(), 'utf8');
  await writeFile(
    join(registryDir, 'mcp-servers.json'),
    JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          configVersion: 1,
          serverId: 'bad-environment',
          name: 'Bad environment',
          enabled: true,
          transport: {
            kind: 'stdio',
            command: process.execPath,
            args: [serverScript],
            envKeys: [missingEnvironmentKey],
            connectionTimeoutMs: MCP_CONCURRENT_STARTUP_TEST_TIMEOUT_MS,
            requestTimeoutMs: 5000,
          },
        },
        ...['a', 'b'].map((marker) => ({
          configVersion: 1,
          serverId: `gated-${marker}`,
          name: `Gated ${marker.toUpperCase()}`,
          enabled: true,
          transport: {
            kind: 'stdio' as const,
            command: process.execPath,
            args: [serverScript, markerDir, marker],
            envKeys: [],
            connectionTimeoutMs: MCP_CONCURRENT_STARTUP_TEST_TIMEOUT_MS,
            requestTimeoutMs: 5000,
          },
        })),
      ],
    }),
    'utf8',
  );
  const runtime = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });

  try {
    await runtime.initialize();
    const views = runtime.listServers();
    assert.equal(
      views.find((server) => server.serverId === 'bad-environment')?.runtime
        .state,
      'error',
    );
    assert.equal(
      views.find((server) => server.serverId === 'gated-a')?.runtime.state,
      'ready',
    );
    assert.equal(
      views.find((server) => server.serverId === 'gated-b')?.runtime.state,
      'ready',
    );
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('global MCP enforces lifecycle guards and validates disabled server operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-mcp-lifecycle-'));
  const closedRuntime = createGlobalMcpRuntime({
    homeStateRoot: join(root, 'closed'),
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot: join(root, 'active'),
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  try {
    assert.throws(() => runtime.listServers(), /not initialized/u);
    await closedRuntime.close();
    await closedRuntime.close();
    await assert.rejects(closedRuntime.initialize(), /runtime is closed/u);

    await runtime.initialize();
    await runtime.initialize();
    for (const request of [
      {
        name: '   ',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: 'node',
          args: [],
          envKeys: [],
        },
      },
      {
        name: 'Invalid command',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: '   ',
          args: [],
          envKeys: [],
        },
      },
      {
        name: 'Invalid environment',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: 'node',
          args: [],
          envKeys: ['INVALID-KEY'],
        },
      },
      {
        name: 'Invalid connection timeout',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: 'node',
          args: [],
          envKeys: [],
          connectionTimeoutMs: 0,
        },
      },
      {
        name: 'Invalid request timeout',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: 'node',
          args: [],
          envKeys: [],
          requestTimeoutMs: 1.5,
        },
      },
      {
        name: 'Invalid shutdown timeout',
        enabled: false,
        transport: {
          kind: 'stdio' as const,
          command: 'node',
          args: [],
          envKeys: [],
          shutdownGraceMs: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ]) {
      await assert.rejects(
        runtime.addServer(request),
        (error: unknown) => error instanceof McpServerConfigError,
      );
    }

    const added = await runtime.addServer({
      name: '  Disabled server  ',
      enabled: false,
      transport: {
        kind: 'stdio',
        command: '  node  ',
        args: ['server.mjs'],
        envKeys: ['PATH', 'PATH'],
        connectionTimeoutMs: 1_000,
        requestTimeoutMs: 2_000,
        shutdownGraceMs: 3_000,
      },
    });
    assert.equal(added.name, 'Disabled server');
    assert.equal(added.transport.command, 'node');
    assert.deepEqual(added.transport.envKeys, ['PATH']);
    assert.equal(added.runtime.disabledReason, 'server-disabled');
    assert.deepEqual(
      await runtime.setServerEnabled(added.serverId, false),
      added,
    );
    await assert.rejects(
      runtime.setServerEnabled('missing-server', true),
      (error: unknown) => error instanceof McpServerNotFoundError,
    );
    await assert.rejects(
      runtime.installTool('missing-server', 'echo'),
      (error: unknown) => error instanceof McpServerNotFoundError,
    );
    await assert.rejects(
      runtime.uninstallTool('missing-server', 'echo'),
      (error: unknown) => error instanceof McpServerNotFoundError,
    );
    await assert.rejects(
      runtime.removeServer('missing-server'),
      (error: unknown) => error instanceof McpServerNotFoundError,
    );
    await assert.rejects(
      runtime.installTool(added.serverId, ''),
      (error: unknown) => error instanceof McpServerConfigError,
    );
    await assert.rejects(
      runtime.installTool(added.serverId, 'echo'),
      (error: unknown) => error instanceof McpServerConfigError,
    );
    await assert.rejects(
      runtime.uninstallTool(added.serverId, ''),
      (error: unknown) => error instanceof McpServerConfigError,
    );
    assert.deepEqual(
      await runtime.uninstallTool(added.serverId, 'not-installed'),
      added,
    );
    await runtime.removeServer(added.serverId);
    assert.deepEqual(runtime.listServers(), []);
    await runtime.close();
    await runtime.close();
    assert.throws(() => runtime.listServers(), /runtime is closed/u);
  } finally {
    await runtime.close().catch(() => undefined);
    await closedRuntime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void test('global MCP migrates v2 and v3 registries without losing installed tool preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-mcp-versioned-'));
  try {
    for (const fixture of [
      {
        schemaVersion: 2,
        registration: {
          configVersion: 1,
          serverId: 'legacy-v2-server',
          name: 'Legacy v2 server',
          enabled: false,
          source: { kind: 'manual' as const },
          transport: {
            kind: 'stdio' as const,
            command: 'node',
            args: [],
            envKeys: [],
          },
        },
        installedToolNames: [] as string[],
      },
      {
        schemaVersion: 3,
        registration: {
          configVersion: 2,
          serverId: 'previous-v3-server',
          name: 'Previous v3 server',
          enabled: false,
          installedToolNames: ['echo'],
          source: { kind: 'manual' as const },
          transport: {
            kind: 'stdio' as const,
            command: 'node',
            args: [],
            envKeys: [],
          },
        },
        installedToolNames: ['echo'],
      },
    ]) {
      const homeStateRoot = join(root, `schema-${fixture.schemaVersion}`);
      const registryRoot = join(homeStateRoot, '.geulbat');
      const registryPath = join(registryRoot, 'mcp-servers.json');
      await mkdir(registryRoot, { recursive: true });
      await writeFile(
        registryPath,
        `${JSON.stringify({
          schemaVersion: fixture.schemaVersion,
          servers: [fixture.registration],
        })}\n`,
      );
      const runtime = createGlobalMcpRuntime({
        homeStateRoot,
        toolRegistry: createToolRegistryStore({ builtins: [] }),
      });
      try {
        await runtime.initialize();
        assert.deepEqual(
          runtime.listServers()[0]?.installedToolNames,
          fixture.installedToolNames,
        );
        const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as {
          schemaVersion?: number;
          servers?: Array<{
            configVersion?: number;
            installedToolNames?: string[];
          }>;
        };
        assert.equal(persisted.schemaVersion, 4);
        assert.equal(persisted.servers?.[0]?.configVersion, 3);
        assert.deepEqual(
          persisted.servers?.[0]?.installedToolNames,
          fixture.installedToolNames,
        );
      } finally {
        await runtime.close().catch(() => undefined);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('global MCP rejects malformed and duplicate persisted registries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-mcp-registry-errors-'));
  const registryRoot = join(root, '.geulbat');
  const registryPath = join(registryRoot, 'mcp-servers.json');
  await mkdir(registryRoot, { recursive: true });
  try {
    await writeFile(registryPath, '{not-json');
    await assert.rejects(
      createGlobalMcpRuntime({
        homeStateRoot: root,
        toolRegistry: createToolRegistryStore({ builtins: [] }),
      }).initialize(),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /not valid JSON/u.test(error.message),
    );

    const duplicate = {
      configVersion: 3,
      serverId: 'duplicate-server',
      name: 'Duplicate server',
      enabled: false,
      installedToolNames: [],
      source: { kind: 'manual' },
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [],
        envKeys: [],
      },
    };
    await writeFile(
      registryPath,
      JSON.stringify({ schemaVersion: 4, servers: [duplicate, duplicate] }),
    );
    await assert.rejects(
      createGlobalMcpRuntime({
        homeStateRoot: root,
        toolRegistry: createToolRegistryStore({ builtins: [] }),
      }).initialize(),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /duplicate server id/u.test(error.message),
    );

    await writeFile(
      registryPath,
      JSON.stringify({
        schemaVersion: 3,
        servers: [
          {
            ...duplicate,
            configVersion: 2,
            installedToolNames: ['echo', 'echo'],
          },
        ],
      }),
    );
    await assert.rejects(
      createGlobalMcpRuntime({
        homeStateRoot: root,
        toolRegistry: createToolRegistryStore({ builtins: [] }),
      }).initialize(),
      (error: unknown) =>
        error instanceof McpServerConfigError &&
        /invalid shape/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('global MCP rejects duplicate plugin bindings and tolerates empty plugin cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-mcp-plugin-guards-'));
  const source = {
    kind: 'plugin' as const,
    installationId: '33333333-3333-4333-8333-333333333333',
    name: 'duplicate-plugin',
    displayName: 'Duplicate Plugin',
    version: '1.0.0',
    contentDigest: `sha256:${'c'.repeat(64)}`,
    serverName: 'duplicate',
  };
  const binding: PluginMcpServerBinding = {
    name: 'Duplicate Plugin · duplicate',
    pluginEnabled: false,
    source,
    transport: {
      kind: 'stdio',
      command: 'node',
      args: [],
      envKeys: [],
    },
    async resolveLaunch() {
      return { cwd: root };
    },
  };
  const duplicateRuntime = createGlobalMcpRuntime({
    homeStateRoot: join(root, 'duplicate'),
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  const runtime = createGlobalMcpRuntime({
    homeStateRoot: join(root, 'empty'),
    toolRegistry: createToolRegistryStore({ builtins: [] }),
  });
  try {
    await assert.rejects(
      duplicateRuntime.initialize([binding, binding]),
      (error: unknown) => error instanceof McpServerConfigError,
    );
    await runtime.initialize();
    await runtime.reconcilePluginServers([]);
    await runtime.suspendPluginServers(source.installationId);
    await runtime.removePluginServers(source.installationId);
    assert.deepEqual(runtime.listServers(), []);
  } finally {
    await duplicateRuntime.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function createEchoMcpServerSource(): string {
  const serverModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/index.js'),
  ).href;
  const stdioModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  ).href;
  const typesModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/types.js'),
  ).href;
  return `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from ${JSON.stringify(typesModule)};

const markerDir = process.argv[2];
const markerName = process.argv[3];
if (markerDir && markerName) {
  writeFileSync(join(markerDir, markerName), 'started');
  while (!existsSync(join(markerDir, 'a')) || !existsSync(join(markerDir, 'b'))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const server = new Server(
  { name: 'geulbat-test-echo', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo a test value',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'schema_echo',
      description: 'Echo a nested schema value',
      inputSchema: {
        type: 'object',
        properties: { payload: { $ref: '#/$defs/Payload' } },
        required: ['payload'],
        additionalProperties: false,
        $defs: {
          Payload: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: { echo: { type: 'string' } },
        required: ['echo'],
        additionalProperties: false,
      },
    },
    {
      name: 'app_only_refresh',
      description: 'Refresh an MCP App without exposing it to the model',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    {
      name: 'broken_schema',
      description: 'Advertise a schema that must fail only when installed',
      inputSchema: {
        type: 'object',
        properties: { payload: { $ref: '#/$defs/Missing' } },
        required: ['payload'],
        additionalProperties: false,
      },
    },
    {
      name: 'broken_output_schema',
      description: 'Advertise an output schema that fails only when installed',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { payload: { $ref: '#/$defs/Missing' } },
        required: ['payload'],
        additionalProperties: false,
      },
    },
    {
      name: 'recursive_schema',
      description: 'Advertise a recursive local input schema',
      inputSchema: {
        type: 'object',
        properties: { payload: { $ref: '#/$defs/Loop' } },
        $defs: { Loop: { $ref: '#/$defs/Loop' } },
      },
    },
    {
      name: 'remote_schema',
      description: 'Advertise an unsupported remote input schema',
      inputSchema: {
        type: 'object',
        properties: { payload: { $ref: 'https://example.test/schema.json' } },
      },
    },
    {
      name: 'invalid_ref_schema',
      description: 'Advertise an invalid encoded local schema reference',
      inputSchema: {
        type: 'object',
        properties: { payload: { $ref: '#/%E0%A4%A' } },
      },
    },
    {
      name: 'required_task',
      description: 'Require the MCP task execution extension',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execution: { taskSupport: 'required' },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  const value = request.params.name === 'schema_echo'
    ? args.payload?.text
    : args.text;
  const text = String(value ?? '');
  if (text === 'throw') {
    throw new Error('fixture tool failure');
  }
  if (text === 'server-error') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'fixture server error' }],
    };
  }
  return {
    content: [{ type: 'text', text: 'echo:' + text }],
    ...(request.params.name === 'schema_echo' && text !== 'missing-output'
      ? {
          structuredContent: {
            echo: text === 'invalid-output' ? 42 : text,
          },
        }
      : {}),
  };
});
await server.connect(new StdioServerTransport());
`;
}

function createCursorLoopMcpServerSource(): string {
  const serverModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/index.js'),
  ).href;
  const stdioModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  ).href;
  const typesModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/types.js'),
  ).href;
  return `
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
import { ListToolsRequestSchema } from ${JSON.stringify(typesModule)};

let listCount = 0;
const server = new Server(
  { name: 'geulbat-test-cursor-loop', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  listCount += 1;
  if (listCount > 2) {
    throw new Error('cursor loop was not stopped by the client');
  }
  return { tools: [], nextCursor: 'repeated-cursor' };
});
await server.connect(new StdioServerTransport());
`;
}

function findProjectedToolName(
  registry: ReturnType<typeof createToolRegistryStore>,
  rawToolName: string,
): string | undefined {
  return registry
    .getAllRegisteredToolNames()
    .find((name) =>
      registry.getTool(name)?.description.includes(`tool "${rawToolName}"`),
    );
}
