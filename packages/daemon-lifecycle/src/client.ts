import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE,
  DAEMON_LIFECYCLE_START_COMMAND_TYPE,
  parseDaemonLifecycleEvent,
  type DaemonLifecycleCommand,
  type DaemonLifecycleEvent,
  type DaemonShutdownSignal,
} from './protocol.js';

export interface DaemonLifecycleClient {
  run(): Promise<void>;
  shutdown(signal: DaemonShutdownSignal): void;
}

/**
 * `tsc` 패키지는 client.js 옆에 worker.js를 둔다. 개발 번들은 source
 * `import.meta.url`을 보존하므로 실행 중인 번들 엔트리 옆의 별도 mjs
 * 엔트리를 사용한다. 둘 다 없으면 존재하지 않는 경로를 fork하지 않고
 * 배치 계약 오류를 바로 보고한다.
 */
function resolveDaemonLifecycleWorkerEntry(): string {
  const sibling = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (existsSync(sibling)) {
    return sibling;
  }
  const bundleEntry = process.argv[1];
  if (bundleEntry !== undefined) {
    const bundled = join(dirname(bundleEntry), 'daemon-lifecycle-worker.mjs');
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  throw new Error(
    'daemon lifecycle worker entry was not found — expected worker.js next to the compiled client or daemon-lifecycle-worker.mjs next to the development bundle',
  );
}

export function createDaemonLifecycleClient(args: {
  entrypoint?: string;
  arguments: readonly string[];
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  onEvent?: (event: DaemonLifecycleEvent) => void;
}): DaemonLifecycleClient {
  let phase: 'created' | 'running' | 'stopping' | 'stopped' = 'created';
  let worker: ChildProcess | undefined;
  let runPromise: Promise<void> | undefined;
  let commandSequence = Promise.resolve();
  let transportFailure: Error | undefined;
  const lifecycleRunId = randomUUID();

  const failTransport = (
    error: unknown,
    fallbackSignal: DaemonShutdownSignal = 'SIGTERM',
  ): void => {
    transportFailure ??= toError(error);
    const activeWorker = worker;
    if (
      activeWorker !== undefined &&
      activeWorker.exitCode === null &&
      activeWorker.signalCode === null
    ) {
      activeWorker.kill(fallbackSignal);
    }
  };

  return {
    run() {
      if (phase === 'stopping') {
        phase = 'stopped';
        return Promise.resolve();
      }
      if (phase !== 'created') {
        throw new Error('daemon lifecycle client can only be run once');
      }
      const entrypoint = args.entrypoint ?? process.argv[1];
      if (entrypoint === undefined) {
        throw new Error(
          'daemon lifecycle client requires the current process entrypoint',
        );
      }
      phase = 'running';
      const execArgv = args.execArgv ?? process.execArgv;
      const activeWorker = fork(resolveDaemonLifecycleWorkerEntry(), [], {
        env: args.env ?? process.env,
        execArgv: [...execArgv],
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      worker = activeWorker;
      let lifecycleFailure: string | undefined;
      let observedStopped = false;

      runPromise = new Promise<void>((resolve, reject) => {
        const removeListeners = (): void => {
          activeWorker.off('message', onMessage);
          activeWorker.off('error', onError);
          activeWorker.off('exit', onExit);
        };
        const onMessage = (message: unknown): void => {
          const event = parseDaemonLifecycleEvent(message);
          if (event === undefined || event.lifecycleRunId !== lifecycleRunId) {
            failTransport(
              new Error('daemon lifecycle worker sent an invalid IPC event'),
            );
            return;
          }
          if (event.state === 'failed') {
            lifecycleFailure =
              event.detail ?? 'daemon lifecycle worker reported failure';
          }
          if (event.state === 'stopped') {
            observedStopped = true;
          }
          try {
            args.onEvent?.(event);
          } catch (error) {
            failTransport(error);
          }
        };
        const onError = (error: Error): void => {
          failTransport(error);
        };
        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          removeListeners();
          worker = undefined;
          phase = 'stopped';
          if (transportFailure !== undefined) {
            reject(transportFailure);
            return;
          }
          if (lifecycleFailure !== undefined) {
            reject(new Error(lifecycleFailure));
            return;
          }
          if (code === 0 && observedStopped) {
            resolve();
            return;
          }
          reject(
            new Error(
              `daemon lifecycle worker exited without a stopped event (code=${String(
                code,
              )}, signal=${String(signal)})`,
            ),
          );
        };

        activeWorker.on('message', onMessage);
        activeWorker.once('error', onError);
        activeWorker.once('exit', onExit);
      });
      const startCommand: DaemonLifecycleCommand = {
        type: DAEMON_LIFECYCLE_START_COMMAND_TYPE,
        lifecycleRunId,
        entrypoint,
        arguments: [...args.arguments],
        execArgv: [...execArgv],
      };
      commandSequence = commandSequence
        .then(() => sendWorkerMessage(activeWorker, startCommand))
        .catch((error: unknown) => {
          failTransport(error);
        });
      return runPromise;
    },

    shutdown(signal) {
      if (phase === 'stopped' || phase === 'stopping') {
        return;
      }
      phase = 'stopping';
      const activeWorker = worker;
      if (activeWorker === undefined) {
        return;
      }
      const shutdownCommand: DaemonLifecycleCommand = {
        type: DAEMON_LIFECYCLE_SHUTDOWN_COMMAND_TYPE,
        lifecycleRunId,
        signal,
      };
      commandSequence = commandSequence
        .then(() => sendWorkerMessage(activeWorker, shutdownCommand))
        .catch((error: unknown) => {
          failTransport(error, signal);
        });
    },
  };
}

function sendWorkerMessage(
  worker: ChildProcess,
  message: DaemonLifecycleCommand,
): Promise<void> {
  if (!worker.connected) {
    return Promise.reject(
      new Error('daemon lifecycle worker IPC channel is disconnected'),
    );
  }
  return new Promise<void>((resolve, reject) => {
    worker.send(message, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
