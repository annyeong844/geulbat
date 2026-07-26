import { fork, type ChildProcess } from 'node:child_process';

export const GEULBAT_DAEMON_CHILD_ARGUMENT = '--geulbat-daemon-child';

const DAEMON_READY_MESSAGE_TYPE = 'geulbat-daemon-ready';

export type DaemonShutdownSignal = 'SIGINT' | 'SIGTERM';

interface DaemonExitObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface DaemonSupervisor {
  run(): Promise<void>;
  shutdown(signal: DaemonShutdownSignal): void;
}

/**
 * 제품 프로세스가 데몬 자식의 수명만 소유한다. 별도 heartbeat 타이머를 만들지
 * 않고 자식 exit와 listen-ready IPC라는 두 사건으로 판정한다.
 *
 * ready였던 세대의 예고 없는 종료는 즉시 새 세대를 세운다. 새 세대가 listen
 * 전에 실패하면 다시 반복하지 않고 부모도 실패한다. 따라서 숨은 재시작 횟수나
 * 지연 정책 없이 크래시 복구와 startup 폭주 방지를 함께 지킨다.
 */
export function createDaemonSupervisor(args: {
  entrypoint: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  onUnexpectedExit?: (observation: DaemonExitObservation) => void;
}): DaemonSupervisor {
  let phase: 'created' | 'running' | 'stopping' | 'stopped' = 'created';
  let child: ChildProcess | undefined;
  let shutdownSignal: DaemonShutdownSignal = 'SIGTERM';

  return {
    async run() {
      if (phase === 'stopping') {
        phase = 'stopped';
        return;
      }
      if (phase !== 'created') {
        throw new Error('daemon supervisor can only be run once');
      }
      phase = 'running';
      try {
        while (phase === 'running') {
          const generation = fork(
            args.entrypoint,
            [GEULBAT_DAEMON_CHILD_ARGUMENT],
            {
              env: args.env ?? process.env,
              ...(args.execArgv === undefined
                ? {}
                : { execArgv: [...args.execArgv] }),
              stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            },
          );
          child = generation;
          const outcome = await observeDaemonGeneration(generation);
          if (child === generation) {
            child = undefined;
          }
          if (phase !== 'running') {
            return;
          }
          if (!outcome.ready) {
            throw new Error(
              `daemon exited before listen readiness (code=${String(
                outcome.code,
              )}, signal=${String(outcome.signal)})`,
            );
          }
          args.onUnexpectedExit?.({
            code: outcome.code,
            signal: outcome.signal,
          });
        }
      } finally {
        phase = 'stopped';
      }
    },

    shutdown(signal) {
      if (phase === 'stopped' || phase === 'stopping') {
        return;
      }
      shutdownSignal = signal;
      phase = 'stopping';
      const activeChild = child;
      if (
        activeChild !== undefined &&
        activeChild.exitCode === null &&
        activeChild.signalCode === null
      ) {
        activeChild.kill(shutdownSignal);
      }
    },
  };
}

export async function notifyDaemonSupervisorReady(): Promise<void> {
  const send = process.send;
  if (send === undefined) {
    throw new Error('daemon child requires a supervisor IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    send.call(process, { type: DAEMON_READY_MESSAGE_TYPE }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function observeDaemonGeneration(
  child: ChildProcess,
): Promise<DaemonExitObservation & { ready: boolean }> {
  return new Promise((resolve) => {
    let ready = false;
    let settled = false;
    const settle = (
      observation: DaemonExitObservation & { ready: boolean },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(observation);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === DAEMON_READY_MESSAGE_TYPE
      ) {
        ready = true;
      }
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
