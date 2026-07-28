import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createDaemonHostCommandRuntime } from '../../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from '../../host-routed-detached-process.js';
import { SYSTEM_SESSION_OWNER } from '../../host-command-output-store.js';
import {
  encodePtcEpochCallbackHostFrame,
  parsePtcEpochCallbackHostFrame,
  type PtcEpochCallbackDaemonFrame,
  type PtcEpochCallbackHostFrame,
} from './epoch-callback-host-protocol.js';
import {
  createHostRoutedPtcEpochCallbackChannelFactory,
  createHostRoutedPtcEpochCallbackControllerAttacher,
} from './host-routed-epoch-callback.js';

const unixTest = process.platform === 'win32' ? test.skip : test;

interface NodeModuleCommand {
  execPath: string;
  args: string[];
}

class SocketLineReader {
  private buffer = '';
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];

  constructor(socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const newlineIndex = this.buffer.indexOf('\n');
        if (newlineIndex < 0) {
          return;
        }
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.lines.push(line);
        } else {
          waiter(line);
        }
      }
    });
  }

  async next(): Promise<string> {
    const line = this.lines.shift();
    return line ?? (await new Promise((resolve) => this.waiters.push(resolve)));
  }
}

interface ControlEndpoint {
  socketPath: string;
  accepted: Promise<Socket>;
}

function resolveNodeModuleCommand(args: {
  sourceUrl: URL;
  builtUrl: URL;
}): NodeModuleCommand {
  const source = fileURLToPath(args.sourceUrl);
  const built = fileURLToPath(args.builtUrl);
  return existsSync(source)
    ? {
        execPath: process.execPath,
        args: ['--import', fileURLToPath(import.meta.resolve('tsx')), source],
      }
    : { execPath: process.execPath, args: [built] };
}

function commandHostWorkerCommand(): NodeModuleCommand {
  return resolveNodeModuleCommand({
    sourceUrl: new URL('../../../command-host/main.ts', import.meta.url),
    builtUrl: new URL('../../../command-host/main.js', import.meta.url),
  });
}

function callbackHostWorkerCommand(): NodeModuleCommand {
  return resolveNodeModuleCommand({
    sourceUrl: new URL('./epoch-callback-host-main.ts', import.meta.url),
    builtUrl: new URL('./epoch-callback-host-main.js', import.meta.url),
  });
}

async function createControlEndpoint(
  t: { after(fn: () => Promise<void> | void): void },
  label: string,
): Promise<ControlEndpoint> {
  const root = await mkdtemp(join(tmpdir(), `geulbat-${label}-`));
  await chmod(root, 0o700);
  const socketPath = join(root, 'control.sock');
  const server = createServer();
  let acceptedSocket: Socket | undefined;
  const accepted = new Promise<Socket>((resolve) => {
    server.once('connection', (socket) => {
      acceptedSocket = socket;
      resolve(socket);
    });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  t.after(async () => {
    acceptedSocket?.destroy();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  });
  return { socketPath, accepted };
}

async function sendCallbackFrame(
  socketPath: string,
  frame: unknown,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    });
  });
}

function parseHostFrame(line: string): PtcEpochCallbackHostFrame {
  const frame = parsePtcEpochCallbackHostFrame(line);
  assert.ok(frame, `expected callback-host frame, received ${line}`);
  return frame;
}

function sendDaemonFrame(
  socket: Socket,
  frame: PtcEpochCallbackDaemonFrame,
): void {
  socket.write(encodePtcEpochCallbackHostFrame(frame));
}

function createWorkerRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
    requestedMode: 'worker',
    workerCommand: commandHostWorkerCommand(),
  });
}

void unixTest(
  'host-routed callback channel executes outside the daemon and preserves async long-wait admission',
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-host-state-'),
    );
    const callbackRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-host-root-'),
    );
    const runtime = createWorkerRuntime();
    t.after(async () => {
      await runtime.closeAll();
      await removeCommandHostWorkspace(stateRoot);
      await rm(callbackRoot, { recursive: true, force: true });
    });
    const startProcess = createHostRoutedDetachedProcessStarter({
      hostCommands: runtime,
      stateRoot,
      pageLimitBytes: 1024,
      cwd: stateRoot,
      env: process.env,
      runId: 'ptc-callback-host-test',
    });
    const events: string[] = [];
    const createChannel = createHostRoutedPtcEpochCallbackChannelFactory({
      startProcess,
      workerCommand: callbackHostWorkerCommand(),
    });
    const channel = await createChannel({
      rootDir: callbackRoot,
      maxFrameBytes: 4096,
      maxOpenConnections: 2,
      maxCallbacks: 4,
      callbackTimeoutMs: 1000,
      maxResponseBytes: 4096,
      handler: async (invocation) => {
        events.push('handler');
        assert.equal(await invocation.enterLongWait(), true);
        events.push('admitted');
        return { ok: true, result: { value: invocation.args } };
      },
    });

    const response = await sendCallbackFrame(channel.socketPath, {
      requestId: 'host-routed-1',
      token: channel.token,
      kind: 'tool_call',
      args: { value: 'worker-owned' },
    });
    assert.deepEqual(response, {
      requestId: 'host-routed-1',
      ok: true,
      result: { value: { value: 'worker-owned' } },
    });
    assert.deepEqual(events, ['handler', 'admitted']);
    assert.equal((await runtime.describeState(stateRoot)).mode, 'worker');
    await channel.close();
  },
);

void unixTest(
  'the same callback socket accepts work after daemon control is replaced',
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-readoption-state-'),
    );
    const callbackRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-readoption-root-'),
    );
    const runtime1 = createWorkerRuntime();
    const runtime2 = createWorkerRuntime();
    let outputRef: string | undefined;
    t.after(async () => {
      if (outputRef !== undefined) {
        await runtime2.interact({
          stateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          owner: 'system',
          outputRef,
          terminate: true,
          yieldTimeMs: 0,
        });
      }
      await runtime1.closeAll();
      await runtime2.closeAll();
      await removeCommandHostWorkspace(stateRoot);
      await rm(callbackRoot, { recursive: true, force: true });
    });

    const epochId = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const callbackSocketPath = join(
      callbackRoot,
      `ptc-epoch-${epochId}`,
      'callback.sock',
    );
    const control1 = await createControlEndpoint(
      t,
      'ptc-callback-control-daemon1',
    );
    const started = await runtime1.start({
      executable: callbackHostWorkerCommand().execPath,
      args: callbackHostWorkerCommand().args,
      cwd: stateRoot,
      env: process.env,
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      streamMode: 'lossless',
      requiresDeferredOutputRelease: true,
      requiresIdempotentStart: true,
      runId: 'ptc-callback-readoption',
      callId: 'ptc-callback-stable-cell',
      stdinMode: 'open',
      outputRedaction: {
        exactMarkers: [token, callbackSocketPath, control1.socketPath],
        replacement: '[redacted:ptc-callback]',
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    outputRef = started.outputRef;
    const claimed = await runtime1.waitForInitialResult({
      stateRoot,
      outputRef,
      yieldTimeMs: 0,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) {
      return;
    }
    const bootstrap = runtime1.interact({
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef,
      chars: encodePtcEpochCallbackHostFrame({
        kind: 'initialize_or_attach',
        rootDir: callbackRoot,
        epochId,
        token,
        controlSocketPath: control1.socketPath,
        policy: {
          maxFrameBytes: 4096,
          maxOpenConnections: 2,
          maxCallbacks: 4,
          callbackTimeoutMs: 1000,
          maxResponseBytes: 4096,
        },
      }),
      yieldTimeMs: 0,
    });
    const controlSocket1 = await control1.accepted;
    const controlReader1 = new SocketLineReader(controlSocket1);
    assert.deepEqual(parseHostFrame(await controlReader1.next()), {
      kind: 'ready',
      epochId,
      token,
      socketPath: callbackSocketPath,
    });
    assert.equal((await bootstrap).ok, true);

    const firstResponse = sendCallbackFrame(callbackSocketPath, {
      requestId: 'daemon-1',
      token,
      kind: 'tool_call',
      args: { daemon: 1 },
    });
    const firstInvoke = parseHostFrame(await controlReader1.next());
    assert.equal(firstInvoke.kind, 'invoke');
    if (firstInvoke.kind !== 'invoke') {
      return;
    }
    sendDaemonFrame(controlSocket1, {
      kind: 'settle',
      invocationId: firstInvoke.invocationId,
      handlerResult: { ok: true, result: { servedBy: 1 } },
    });
    assert.deepEqual(await firstResponse, {
      requestId: 'daemon-1',
      ok: true,
      result: { servedBy: 1 },
    });

    await runtime1.closeAll();
    controlSocket1.destroy();
    await delay(20);

    const pendingResponse = sendCallbackFrame(callbackSocketPath, {
      requestId: 'daemon-2',
      token,
      kind: 'tool_call',
      args: { daemon: 2 },
    });
    const replacementEpochId = randomBytes(8).toString('hex');
    const replacementToken = randomBytes(32).toString('hex');
    const replacementSocketPath = join(
      callbackRoot,
      `ptc-epoch-${replacementEpochId}`,
      'callback.sock',
    );
    const control2 = await createControlEndpoint(
      t,
      'ptc-callback-control-daemon2',
    );
    const restarted = await runtime2.start({
      executable: callbackHostWorkerCommand().execPath,
      args: callbackHostWorkerCommand().args,
      cwd: stateRoot,
      env: process.env,
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      streamMode: 'lossless',
      requiresDeferredOutputRelease: true,
      requiresIdempotentStart: true,
      runId: 'ptc-callback-readoption',
      callId: 'ptc-callback-stable-cell',
      stdinMode: 'open',
      outputRedaction: {
        exactMarkers: [
          replacementToken,
          replacementSocketPath,
          control2.socketPath,
        ],
        replacement: '[redacted:ptc-callback]',
      },
    });
    assert.deepEqual(restarted, { ok: true, outputRef });
    if (!restarted.ok) {
      return;
    }
    const reclaimed = await runtime2.waitForInitialResult({
      stateRoot,
      outputRef,
      yieldTimeMs: 0,
    });
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) {
      return;
    }
    const reinitialized = runtime2.interact({
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef,
      chars: encodePtcEpochCallbackHostFrame({
        kind: 'initialize_or_attach',
        rootDir: callbackRoot,
        epochId: replacementEpochId,
        token: replacementToken,
        controlSocketPath: control2.socketPath,
        policy: {
          maxFrameBytes: 4096,
          maxOpenConnections: 2,
          maxCallbacks: 4,
          callbackTimeoutMs: 1000,
          maxResponseBytes: 4096,
        },
      }),
      yieldTimeMs: 0,
    });
    const controlSocket2 = await control2.accepted;
    const controlReader2 = new SocketLineReader(controlSocket2);
    assert.deepEqual(parseHostFrame(await controlReader2.next()), {
      kind: 'ready',
      epochId,
      token,
      socketPath: callbackSocketPath,
    });
    assert.equal((await reinitialized).ok, true);

    const secondInvoke = parseHostFrame(await controlReader2.next());
    assert.equal(secondInvoke.kind, 'invoke');
    if (secondInvoke.kind !== 'invoke') {
      return;
    }
    sendDaemonFrame(controlSocket2, {
      kind: 'settle',
      invocationId: secondInvoke.invocationId,
      handlerResult: {
        ok: true,
        result: { servedBy: 2, args: secondInvoke.args },
      },
    });
    assert.deepEqual(await pendingResponse, {
      requestId: 'daemon-2',
      ok: true,
      result: { servedBy: 2, args: { daemon: 2 } },
    });
    sendDaemonFrame(controlSocket2, { kind: 'shutdown' });
    assert.deepEqual(parseHostFrame(await controlReader2.next()), {
      kind: 'closed',
    });
  },
);

void unixTest(
  'the product controller attacher restores callback authority and closes the adopted host exactly once',
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-controller-state-'),
    );
    const callbackRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-callback-controller-root-'),
    );
    const runtime1 = createWorkerRuntime();
    const runtime2 = createWorkerRuntime();
    let outputRef: string | undefined;
    t.after(async () => {
      if (outputRef !== undefined) {
        await runtime2.interact({
          stateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          owner: 'system',
          outputRef,
          terminate: true,
          yieldTimeMs: 0,
        });
      }
      await runtime1.closeAll();
      await runtime2.closeAll();
      await removeCommandHostWorkspace(stateRoot);
      await rm(callbackRoot, { recursive: true, force: true });
    });

    const epochId = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const callbackSocketPath = join(
      callbackRoot,
      `ptc-epoch-${epochId}`,
      'callback.sock',
    );
    const initialControl = await createControlEndpoint(
      t,
      'ptc-callback-controller-initial',
    );
    const workerCommand = callbackHostWorkerCommand();
    const started = await runtime1.start({
      executable: workerCommand.execPath,
      args: workerCommand.args,
      cwd: stateRoot,
      env: process.env,
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      streamMode: 'lossless',
      requiresDeferredOutputRelease: true,
      requiresIdempotentStart: true,
      runId: 'ptc-callback-controller-readoption',
      callId: 'ptc-callback-controller-cell',
      stdinMode: 'open',
      outputRedaction: {
        exactMarkers: [token, callbackSocketPath, initialControl.socketPath],
        replacement: '[redacted:ptc-callback]',
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    outputRef = started.outputRef;
    assert.equal(
      (
        await runtime1.waitForInitialResult({
          stateRoot,
          outputRef,
          yieldTimeMs: 0,
        })
      ).ok,
      true,
    );
    const initialized = runtime1.interact({
      stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef,
      chars: encodePtcEpochCallbackHostFrame({
        kind: 'initialize_or_attach',
        rootDir: callbackRoot,
        epochId,
        token,
        controlSocketPath: initialControl.socketPath,
        policy: {
          maxFrameBytes: 4096,
          maxOpenConnections: 2,
          maxCallbacks: 4,
          callbackTimeoutMs: 1000,
          maxResponseBytes: 4096,
        },
      }),
      yieldTimeMs: 0,
    });
    const initialSocket = await initialControl.accepted;
    const initialReader = new SocketLineReader(initialSocket);
    assert.deepEqual(parseHostFrame(await initialReader.next()), {
      kind: 'ready',
      epochId,
      token,
      socketPath: callbackSocketPath,
    });
    assert.equal((await initialized).ok, true);

    await runtime1.closeAll();
    initialSocket.destroy();
    await delay(20);

    const attachProcess = createHostRoutedDetachedProcessAttacher({
      hostCommands: runtime2,
      stateRoot,
      pageLimitBytes: 1024,
    });
    const attachController = createHostRoutedPtcEpochCallbackControllerAttacher(
      { attachProcess },
    );
    const controller = await attachController({
      outputRef,
      handler: async (invocation) => ({
        ok: true,
        result: { owner: 'replacement', args: invocation.args },
      }),
    });
    assert.equal(controller.processOutputRef, outputRef);
    assert.deepEqual(
      await sendCallbackFrame(callbackSocketPath, {
        requestId: 'controller-replacement',
        token,
        kind: 'tool_call',
        args: { turn: 1 },
      }),
      {
        requestId: 'controller-replacement',
        ok: true,
        result: { owner: 'replacement', args: { turn: 1 } },
      },
    );

    controller.replaceHandler(async (invocation) => ({
      ok: true,
      result: { owner: 'claimed', args: invocation.args },
    }));
    assert.deepEqual(
      await sendCallbackFrame(callbackSocketPath, {
        requestId: 'controller-claimed',
        token,
        kind: 'tool_call',
        args: { turn: 2 },
      }),
      {
        requestId: 'controller-claimed',
        ok: true,
        result: { owner: 'claimed', args: { turn: 2 } },
      },
    );

    await controller.close();
    await controller.close();
    outputRef = undefined;
  },
);

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
