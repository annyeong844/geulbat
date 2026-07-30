import { fork, type ChildProcess } from 'node:child_process';

import {
  DAEMON_LIFECYCLE_EVENT_TYPE,
  DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE,
  DAEMON_LIFECYCLE_START_COMMAND_TYPE,
  isDaemonLifecycleReadyMessage,
  parseDaemonLifecycleCommand,
  type DaemonLifecycleEvent,
  type DaemonLifecycleStartCommand,
  type DaemonShutdownSignal,
} from './protocol.js';

interface DaemonGenerationOutcome {
  ready: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function runDaemonLifecycleWorker(): Promise<boolean> {
  process.channel?.ref();
  const start = await waitForStartCommand();
  const lifecycleState: { phase: 'running' | 'stopping' } = {
    phase: 'running',
  };
  let shutdownSignal: DaemonShutdownSignal = 'SIGTERM';
  let activeChild: ChildProcess | undefined;
  let protocolFailure: Error | undefined;

  const requestStop = (signal: DaemonShutdownSignal, failure?: Error): void => {
    shutdownSignal = signal;
    lifecycleState.phase = 'stopping';
    protocolFailure ??= failure;
    const child = activeChild;
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill(shutdownSignal);
    }
  };
  const isStopping = (): boolean => lifecycleState.phase === 'stopping';
  const onCommand = (message: unknown): void => {
    const command = parseDaemonLifecycleCommand(message);
    if (
      command === undefined ||
      command.lifecycleRunId !== start.lifecycleRunId ||
      command.type === DAEMON_LIFECYCLE_START_COMMAND_TYPE
    ) {
      requestStop(
        'SIGTERM',
        new Error('daemon lifecycle worker received an invalid IPC command'),
      );
      return;
    }
    if (command.type === DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE) {
      requestStop(command.signal);
    }
  };
  const onDisconnect = (): void => {
    requestStop('SIGTERM');
  };
  process.on('message', onCommand);
  process.once('disconnect', onDisconnect);

  let generation = 0;
  try {
    while (lifecycleState.phase === 'running') {
      generation += 1;
      let child: ChildProcess;
      try {
        child = fork(start.entrypoint, [...start.arguments], {
          env: process.env,
          execArgv: [...start.execArgv],
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
      } catch (error) {
        await sendEvent(
          lifecycleEvent(start, generation, 'failed', {
            detail: `daemon generation spawn failed: ${errorMessage(error)}`,
          }),
        );
        await sendEvent(lifecycleEvent(start, generation, 'stopped'));
        return false;
      }
      activeChild = child;
      let eventSequence = Promise.resolve();
      const enqueueGenerationEvent = (event: DaemonLifecycleEvent): void => {
        eventSequence = eventSequence
          .then(() => sendEvent(event))
          .catch((error: unknown) => {
            requestStop('SIGTERM', new Error(errorMessage(error)));
          });
      };
      enqueueGenerationEvent(
        lifecycleEvent(start, generation, 'starting', {
          pid: child.pid ?? null,
        }),
      );
      const outcome = await observeDaemonGeneration(child, () => {
        enqueueGenerationEvent(
          lifecycleEvent(start, generation, 'ready', {
            pid: child.pid ?? null,
          }),
        );
      });
      await eventSequence;
      if (activeChild === child) {
        activeChild = undefined;
      }
      const expected = isStopping();
      await sendEvent(
        lifecycleEvent(start, generation, 'exited', {
          code: outcome.code,
          detail: outcome.ready ? null : 'daemon exited before readiness',
          expected,
          pid: child.pid ?? null,
          signal: outcome.signal,
        }),
      );
      if (protocolFailure !== undefined) {
        await sendEvent(
          lifecycleEvent(start, generation, 'failed', {
            detail: protocolFailure.message,
          }),
        );
        await sendEvent(lifecycleEvent(start, generation, 'stopped'));
        return false;
      }
      if (expected) {
        await sendEvent(lifecycleEvent(start, generation, 'stopped'));
        return true;
      }
      if (!outcome.ready) {
        await sendEvent(
          lifecycleEvent(start, generation, 'failed', {
            code: outcome.code,
            detail: `daemon exited before listen readiness (code=${String(
              outcome.code,
            )}, signal=${String(outcome.signal)})`,
            signal: outcome.signal,
          }),
        );
        await sendEvent(lifecycleEvent(start, generation, 'stopped'));
        return false;
      }
      await sendEvent(
        lifecycleEvent(start, generation, 'restarting', {
          code: outcome.code,
          signal: outcome.signal,
        }),
      );
    }
    await sendEvent(lifecycleEvent(start, generation, 'stopped'));
    return true;
  } finally {
    process.off('message', onCommand);
    process.off('disconnect', onDisconnect);
    if (process.connected) {
      process.disconnect();
    }
  }
}

function waitForStartCommand(): Promise<DaemonLifecycleStartCommand> {
  if (process.send === undefined) {
    return Promise.reject(
      new Error('daemon lifecycle worker requires a parent IPC channel'),
    );
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = (message: unknown): void => {
      const command = parseDaemonLifecycleCommand(message);
      if (
        command === undefined ||
        command.type !== DAEMON_LIFECYCLE_START_COMMAND_TYPE
      ) {
        cleanup();
        reject(
          new Error(
            'daemon lifecycle worker requires a valid initial start command',
          ),
        );
        return;
      }
      cleanup();
      resolve(command);
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(
        new Error('daemon lifecycle worker parent disconnected before start'),
      );
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function observeDaemonGeneration(
  child: ChildProcess,
  onReady: () => void,
): Promise<DaemonGenerationOutcome> {
  return new Promise((resolve) => {
    let ready = false;
    let settled = false;
    const settle = (outcome: DaemonGenerationOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(outcome);
    };
    const onMessage = (message: unknown): void => {
      if (ready || !isDaemonLifecycleReadyMessage(message)) {
        return;
      }
      ready = true;
      onReady();
    };
    const onError = (): void => {
      settle({ code: child.exitCode, signal: child.signalCode, ready });
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      settle({ code, signal, ready });
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function lifecycleEvent(
  start: DaemonLifecycleStartCommand,
  generation: number,
  state: DaemonLifecycleEvent['state'],
  fields: Partial<
    Pick<
      DaemonLifecycleEvent,
      'pid' | 'code' | 'signal' | 'expected' | 'detail'
    >
  > = {},
): DaemonLifecycleEvent {
  return {
    type: DAEMON_LIFECYCLE_EVENT_TYPE,
    lifecycleRunId: start.lifecycleRunId,
    generation,
    state,
    pid: fields.pid ?? null,
    code: fields.code ?? null,
    signal: fields.signal ?? null,
    expected: fields.expected ?? false,
    detail: fields.detail ?? null,
  };
}

function sendEvent(event: DaemonLifecycleEvent): Promise<void> {
  const send = process.send?.bind(process);
  if (send === undefined || !process.connected) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    send(event, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  const succeeded = await runDaemonLifecycleWorker();
  if (!succeeded) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
