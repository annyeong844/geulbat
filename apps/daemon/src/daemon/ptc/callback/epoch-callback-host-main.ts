import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

import {
  createPtcEpochCallbackChannel,
  type PtcEpochCallbackChannel,
  type PtcEpochCallbackHandler,
  type PtcEpochCallbackHandlerInvocation,
} from './epoch-callback.js';
import {
  encodePtcEpochCallbackHostFrame,
  parsePtcEpochCallbackDaemonFrame,
  parsePtcEpochCallbackHostCommand,
  type PtcEpochCallbackDaemonFrame,
  type PtcEpochCallbackHostFrame,
} from './epoch-callback-host-protocol.js';
import { runDetached } from '../../utils/run-detached.js';

type PtcEpochCallbackHandlerResult = Awaited<
  ReturnType<PtcEpochCallbackHandler>
>;

interface PendingCallback {
  invocation: PtcEpochCallbackHandlerInvocation;
  resolve(result: PtcEpochCallbackHandlerResult): void;
  sentControlGeneration?: number;
}

interface ActiveControl {
  generation: number;
  socket: Socket;
}

const CALLBACK_HANDLER_LOST_RESULT: PtcEpochCallbackHandlerResult = {
  ok: false,
  errorCode: 'callback_handler_failed',
  message: 'PTC callback handler failed',
};

async function runPtcEpochCallbackHost(): Promise<number> {
  let channel: PtcEpochCallbackChannel | undefined;
  let activeControl: ActiveControl | undefined;
  let nextControlGeneration = 0;
  let closing = false;
  let finished = false;
  const pendingCallbacks = new Map<string, PendingCallback>();
  const commandLines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let resolveFinished: (code: number) => void = () => undefined;
  const finishedPromise = new Promise<number>((resolve) => {
    resolveFinished = resolve;
  });

  function finish(code: number): void {
    if (finished) {
      return;
    }
    finished = true;
    commandLines.close();
    process.stdin.pause();
    resolveFinished(code);
  }

  function sendControl(
    frame: PtcEpochCallbackHostFrame,
    expectedGeneration?: number,
  ): boolean {
    const control = activeControl;
    if (
      control === undefined ||
      control.socket.destroyed ||
      (expectedGeneration !== undefined &&
        control.generation !== expectedGeneration)
    ) {
      return false;
    }
    try {
      control.socket.write(encodePtcEpochCallbackHostFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  function settlePending(
    invocationId: string,
    result: PtcEpochCallbackHandlerResult,
  ): void {
    const pending = pendingCallbacks.get(invocationId);
    if (pending === undefined) {
      return;
    }
    pendingCallbacks.delete(invocationId);
    const abortHandler = pendingAbortHandlers.get(invocationId);
    if (abortHandler !== undefined) {
      pending.invocation.signal.removeEventListener('abort', abortHandler);
    }
    pendingAbortHandlers.delete(invocationId);
    pending.resolve(result);
  }

  const pendingAbortHandlers = new Map<string, () => void>();

  function sendInvocation(
    invocationId: string,
    pending: PendingCallback,
  ): void {
    const control = activeControl;
    if (
      control === undefined ||
      control.socket.destroyed ||
      pending.sentControlGeneration !== undefined
    ) {
      return;
    }
    const sent = sendControl({
      kind: 'invoke',
      invocationId,
      requestId: pending.invocation.requestId,
      callbackKind: pending.invocation.kind,
      args: pending.invocation.args,
    });
    if (sent) {
      pending.sentControlGeneration = control.generation;
    }
  }

  function flushPendingInvocations(): void {
    for (const [invocationId, pending] of pendingCallbacks) {
      sendInvocation(invocationId, pending);
    }
  }

  const relayHandler: PtcEpochCallbackHandler = async (invocation) =>
    await new Promise<PtcEpochCallbackHandlerResult>((resolve) => {
      if (closing) {
        resolve(CALLBACK_HANDLER_LOST_RESULT);
        return;
      }
      const invocationId = randomUUID();
      const pending: PendingCallback = { invocation, resolve };
      const onAbort = () => {
        const current = pendingCallbacks.get(invocationId);
        if (current !== pending) {
          return;
        }
        pendingCallbacks.delete(invocationId);
        pendingAbortHandlers.delete(invocationId);
        if (current.sentControlGeneration !== undefined) {
          sendControl(
            { kind: 'cancel', invocationId },
            current.sentControlGeneration,
          );
        }
      };
      pendingCallbacks.set(invocationId, pending);
      pendingAbortHandlers.set(invocationId, onAbort);
      invocation.signal.addEventListener('abort', onAbort, { once: true });
      if (invocation.signal.aborted) {
        onAbort();
        return;
      }
      sendInvocation(invocationId, pending);
    });

  async function handleDaemonFrame(
    frame: PtcEpochCallbackDaemonFrame,
    generation: number,
  ): Promise<void> {
    if (frame.kind === 'shutdown') {
      await shutdown(true);
      return;
    }
    const pending = pendingCallbacks.get(frame.invocationId);
    if (pending === undefined || pending.sentControlGeneration !== generation) {
      return;
    }
    if (frame.kind === 'handler_failed') {
      settlePending(frame.invocationId, CALLBACK_HANDLER_LOST_RESULT);
      return;
    }
    if (frame.kind === 'settle') {
      settlePending(
        frame.invocationId,
        frame.handlerResult as PtcEpochCallbackHandlerResult,
      );
      return;
    }
    const admitted = await pending.invocation.enterLongWait();
    sendControl(
      {
        kind: 'long_wait_result',
        invocationId: frame.invocationId,
        admissionId: frame.admissionId,
        admitted,
      },
      generation,
    );
  }

  function installControl(socket: Socket): ActiveControl {
    nextControlGeneration += 1;
    const control: ActiveControl = {
      generation: nextControlGeneration,
      socket,
    };
    activeControl = control;
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const frame = parsePtcEpochCallbackDaemonFrame(line);
      if (frame !== undefined) {
        runDetached('ptc/callback-host-control-frame', () =>
          handleDaemonFrame(frame, control.generation).catch(() => {
            if ('invocationId' in frame) {
              settlePending(frame.invocationId, CALLBACK_HANDLER_LOST_RESULT);
            }
          }),
        );
      }
    });
    socket.on('close', () => {
      lines.close();
      if (activeControl !== control) {
        return;
      }
      activeControl = undefined;
      for (const [invocationId, pending] of pendingCallbacks) {
        if (pending.sentControlGeneration === control.generation) {
          settlePending(invocationId, CALLBACK_HANDLER_LOST_RESULT);
        }
      }
    });
    return control;
  }

  async function attachControl(
    controlSocketPath: string,
  ): Promise<ActiveControl | undefined> {
    const socket = await connectControl(controlSocketPath);
    if (activeControl !== undefined && !activeControl.socket.destroyed) {
      socket.end(encodePtcEpochCallbackHostFrame({ kind: 'busy' }));
      return undefined;
    }
    return installControl(socket);
  }

  async function bootstrap(
    command: Extract<
      ReturnType<typeof parsePtcEpochCallbackHostCommand>,
      { kind: 'bootstrap' }
    >,
  ): Promise<void> {
    const control = await attachControl(command.controlSocketPath);
    if (control === undefined) {
      finish(1);
      return;
    }
    try {
      channel = await createPtcEpochCallbackChannel({
        rootDir: command.rootDir,
        handler: relayHandler,
        identity: {
          epochId: command.epochId,
          token: command.token,
        },
        ...command.policy,
      });
    } catch {
      sendControl({ kind: 'startup_failed' }, control.generation);
      control.socket.end();
      finish(1);
      return;
    }
    sendReady(control);
    flushPendingInvocations();
  }

  async function initializeOrAttach(
    command: Extract<
      ReturnType<typeof parsePtcEpochCallbackHostCommand>,
      { kind: 'initialize_or_attach' }
    >,
  ): Promise<void> {
    const control = await attachControl(command.controlSocketPath);
    if (control === undefined) {
      return;
    }
    if (channel === undefined) {
      try {
        channel = await createPtcEpochCallbackChannel({
          rootDir: command.rootDir,
          handler: relayHandler,
          identity: {
            epochId: command.epochId,
            token: command.token,
          },
          ...command.policy,
        });
      } catch {
        sendControl({ kind: 'startup_failed' }, control.generation);
        control.socket.end();
        finish(1);
        return;
      }
    }
    sendReady(control);
    flushPendingInvocations();
  }

  function sendReady(control: ActiveControl): void {
    const readyChannel = channel;
    if (readyChannel === undefined) {
      sendControl({ kind: 'startup_failed' }, control.generation);
      return;
    }
    sendControl(
      {
        kind: 'ready',
        epochId: readyChannel.epochId,
        token: readyChannel.token,
        socketPath: readyChannel.socketPath,
      },
      control.generation,
    );
  }

  async function shutdown(reportClosed: boolean, exitCode = 0): Promise<void> {
    if (closing) {
      return;
    }
    closing = true;
    for (const [invocationId, pending] of pendingCallbacks) {
      const abortHandler = pendingAbortHandlers.get(invocationId);
      if (abortHandler !== undefined) {
        pending.invocation.signal.removeEventListener('abort', abortHandler);
      }
      pendingAbortHandlers.delete(invocationId);
      pending.resolve(CALLBACK_HANDLER_LOST_RESULT);
    }
    pendingCallbacks.clear();
    await channel?.close();
    const control = activeControl;
    if (reportClosed && control !== undefined) {
      await new Promise<void>((resolve) => {
        control.socket.end(
          encodePtcEpochCallbackHostFrame({ kind: 'closed' }),
          resolve,
        );
      });
    } else {
      control?.socket.end();
    }
    finish(exitCode);
  }

  const onSignal = () => {
    runDetached('ptc/callback-host-signal', async () => {
      try {
        await shutdown(false);
      } catch {
        activeControl?.socket.destroy();
        finish(1);
      }
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  runDetached('ptc/callback-host-command-loop', async () => {
    try {
      for await (const line of commandLines) {
        const command = parsePtcEpochCallbackHostCommand(line);
        if (command === undefined) {
          await shutdown(false, 2);
          return;
        }
        if (command.kind === 'bootstrap') {
          if (channel !== undefined) {
            await shutdown(false, 2);
            return;
          }
          await bootstrap(command);
          continue;
        }
        if (command.kind === 'initialize_or_attach') {
          await initializeOrAttach(command);
          continue;
        }
        if (channel === undefined) {
          await shutdown(false, 2);
          return;
        }
        const control = await attachControl(command.controlSocketPath);
        if (control !== undefined) {
          sendReady(control);
          flushPendingInvocations();
        }
      }
      await shutdown(false);
    } catch {
      try {
        await shutdown(false, 1);
      } catch {
        activeControl?.socket.destroy();
        finish(1);
      }
    }
  });

  const code = await finishedPromise;
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  return code;
}

async function connectControl(socketPath: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error) => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  runDetached('ptc/callback-host-main', async () => {
    try {
      const code = await runPtcEpochCallbackHost();
      process.exitCode = code;
    } catch {
      process.stderr.write('PTC epoch callback host failed\n');
      process.exitCode = 1;
    }
  });
}
