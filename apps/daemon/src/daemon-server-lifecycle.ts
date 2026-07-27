import type http from 'node:http';
import { isIP } from 'node:net';
import type { WebSocketServer } from 'ws';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { DaemonRuntimeStateStore } from './daemon/runtime-state-store.js';
import type { ActiveRunStore } from './daemon/sessions/active-runs.js';
import { getErrorMessage } from './daemon/utils/error.js';

const logger = createLogger('daemon-server-lifecycle');

type DaemonRuntimeSessionCleanupResult =
  | { ok: true }
  | { ok: false; reasonCode: string; message: string };

interface DaemonRuntimeSessionCloser {
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<DaemonRuntimeSessionCleanupResult>;
}

interface DaemonMcpRuntimeCloser {
  close(args?: { signal?: AbortSignal }): Promise<void>;
}

export interface DaemonRuntimeSessionClosers {
  activeRuns: Pick<ActiveRunStore, 'abortAllRuns' | 'waitForIdle'>;
  computerDirectoryPicker: { close(): Promise<void> };
  globalMcp: DaemonMcpRuntimeCloser;
  hostCommands: DaemonRuntimeSessionCloser;
  provider: { webSocketSessions: DaemonRuntimeSessionCloser };
  ptc: {
    browserPageLoadEvidence: DaemonRuntimeSessionCloser;
    browserTextEvidence: DaemonRuntimeSessionCloser;
    browserNavigate: DaemonRuntimeSessionCloser;
    executeCode: DaemonRuntimeSessionCloser;
  };
  subagentLaunchPromotions: { close(): Promise<void> };
  runtimeStateStore: Pick<DaemonRuntimeStateStore, 'close'>;
}

export async function closeDaemonServers(args: {
  server: http.Server;
  webSocketServers: readonly WebSocketServer[];
}): Promise<void> {
  await Promise.all(args.webSocketServers.map(closeWebSocketServer));
  await closeHttpServer(args.server);
}

export async function closeDaemonForShutdown(args: {
  admissionLock: { release(): Promise<void> };
  runtimeSessions: DaemonRuntimeSessionClosers;
  server: http.Server;
  signal?: AbortSignal;
  webSocketServers: readonly WebSocketServer[];
}): Promise<void> {
  const failures: Error[] = [];
  const attempt = async (
    phase:
      | 'interactiveRequests'
      | 'servers'
      | 'activeRuns'
      | 'runtimeSessions'
      | 'runtimeStateStore'
      | 'admissionLock',
    close: () => Promise<void>,
  ): Promise<void> => {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(
        new Error(`${phase}: ${getErrorMessage(error)}`, { cause: error }),
      );
    }
  };

  await attempt('interactiveRequests', async () => {
    const result = await closeComputerDirectoryPicker(
      args.runtimeSessions.computerDirectoryPicker,
    );
    throwForRuntimeSessionFailures([result]);
  });
  await attempt('servers', () =>
    closeDaemonServers({
      server: args.server,
      webSocketServers: args.webSocketServers,
    }),
  );
  await attempt('activeRuns', async () => {
    args.runtimeSessions.activeRuns.abortAllRuns('daemon_shutdown');
    await args.runtimeSessions.activeRuns.waitForIdle(args.signal);
  });
  await attempt('runtimeSessions', async () => {
    const results = await collectDaemonBackgroundRuntimeSessionResults({
      runtimeSessions: args.runtimeSessions,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    throwForRuntimeSessionFailures(results);
  });
  await attempt('runtimeStateStore', async () => {
    throwForRuntimeSessionFailures([
      closeDaemonRuntimeStateStore(args.runtimeSessions.runtimeStateStore),
    ]);
  });
  await attempt('admissionLock', () => args.admissionLock.release());

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `daemon shutdown cleanup failed: ${failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
}

/**
 * bind가 끝난 뒤 **실제** 포트를 돌려준다. 요청 포트가 0이면(제품 경로) 값을
 * OS가 고르므로, 요청값은 접속 지점의 답이 아니다.
 */
export function listenDaemonHttpServer(args: {
  server: http.Server;
  port: number;
  host: string;
  reportExposureWarning?: (message: string) => void;
}): Promise<number> {
  if (!isLoopbackDaemonBindHost(args.host)) {
    const message = `daemon bind host "${args.host}" is not loopback; local dev-token authentication is intended for single-user local use only`;
    (args.reportExposureWarning ?? ((warning) => logger.warn(warning)))(
      message,
    );
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      args.server.off('error', onError);
      args.server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = args.server.address();
      if (address === null || typeof address === 'string') {
        // TCP bind이 아니면 접속 지점을 알 수 없다. 조용히 요청값을 돌려주면
        // 발견 기록이 틀린 포트를 가리킨다.
        reject(
          new Error(
            'daemon http server listened without a resolvable TCP address',
          ),
        );
        return;
      }
      resolve(address.port);
    };

    args.server.once('error', onError);
    args.server.once('listening', onListening);
    try {
      args.server.listen(args.port, args.host);
    } catch (error: unknown) {
      cleanup();
      reject(
        error instanceof Error ? error : new Error(getErrorMessage(error)),
      );
    }
  });
}

function isLoopbackDaemonBindHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/u, '');
  if (normalizedHost === 'localhost') {
    return true;
  }
  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4) {
    return normalizedHost.startsWith('127.');
  }
  if (ipVersion === 6) {
    return new URL(`http://[${normalizedHost}]`).hostname === '[::1]';
  }
  return false;
}

export async function closeDaemonRuntimeSessions(args: {
  runtimeSessions: DaemonRuntimeSessionClosers;
  signal?: AbortSignal;
}): Promise<void> {
  const [pickerResult, backgroundResults] = await Promise.all([
    closeComputerDirectoryPicker(args.runtimeSessions.computerDirectoryPicker),
    collectDaemonBackgroundRuntimeSessionResults(args),
  ]);
  const runtimeStateStoreResult = closeDaemonRuntimeStateStore(
    args.runtimeSessions.runtimeStateStore,
  );
  throwForRuntimeSessionFailures([
    pickerResult,
    ...backgroundResults,
    runtimeStateStoreResult,
  ]);
}

async function collectDaemonBackgroundRuntimeSessionResults(args: {
  runtimeSessions: DaemonRuntimeSessionClosers;
  signal?: AbortSignal;
}): Promise<ReadonlyArray<Error | undefined>> {
  return await Promise.all([
    closeDaemonMcpRuntime({
      runtime: args.runtimeSessions.globalMcp,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'hostCommands',
      runtime: args.runtimeSessions.hostCommands,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'providerWebSocketSessions',
      runtime: args.runtimeSessions.provider.webSocketSessions,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserPageLoadEvidence',
      runtime: args.runtimeSessions.ptc.browserPageLoadEvidence,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserTextEvidence',
      runtime: args.runtimeSessions.ptc.browserTextEvidence,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserNavigate',
      runtime: args.runtimeSessions.ptc.browserNavigate,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcExecuteCode',
      runtime: args.runtimeSessions.ptc.executeCode,
      signal: args.signal,
    }),
    closeSubagentLaunchPromotions(
      args.runtimeSessions.subagentLaunchPromotions,
    ),
  ]);
}

async function closeSubagentLaunchPromotions(
  promotions: DaemonRuntimeSessionClosers['subagentLaunchPromotions'],
): Promise<Error | undefined> {
  try {
    await promotions.close();
    return undefined;
  } catch (error: unknown) {
    return new Error('subagentLaunchPromotions:threw', { cause: error });
  }
}

function throwForRuntimeSessionFailures(
  results: ReadonlyArray<Error | undefined>,
): void {
  const failures = results.filter(
    (failure): failure is Error => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `daemon runtime session cleanup failed: ${failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
}

async function closeComputerDirectoryPicker(
  picker: DaemonRuntimeSessionClosers['computerDirectoryPicker'],
): Promise<Error | undefined> {
  try {
    await picker.close();
    return undefined;
  } catch (error: unknown) {
    return new Error('computerDirectoryPicker:threw', { cause: error });
  }
}

async function closeDaemonMcpRuntime(args: {
  runtime: DaemonMcpRuntimeCloser;
  signal: AbortSignal | undefined;
}): Promise<Error | undefined> {
  try {
    await args.runtime.close(
      args.signal === undefined ? undefined : { signal: args.signal },
    );
    return undefined;
  } catch (error: unknown) {
    return new Error('globalMcp:threw', { cause: error });
  }
}

function closeDaemonRuntimeStateStore(
  runtimeStateStore: DaemonRuntimeSessionClosers['runtimeStateStore'],
): Error | undefined {
  try {
    runtimeStateStore.close();
    return undefined;
  } catch (error: unknown) {
    return new Error('runtimeStateStore:threw', { cause: error });
  }
}

function closeWebSocketServer(webSocketServer: WebSocketServer): Promise<void> {
  // Upgraded sockets are no longer owned by http.Server.close().
  for (const client of webSocketServer.clients) {
    client.terminate();
  }

  return new Promise((resolve, reject) => {
    webSocketServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeDaemonRuntimeSession(args: {
  label: string;
  runtime: DaemonRuntimeSessionCloser;
  signal: AbortSignal | undefined;
}): Promise<Error | undefined> {
  let result: DaemonRuntimeSessionCleanupResult;
  try {
    result = await args.runtime.closeAll(
      args.signal === undefined ? undefined : { signal: args.signal },
    );
  } catch (error: unknown) {
    return new Error(`${args.label}:threw`, { cause: error });
  }
  if (result.ok) {
    return undefined;
  }
  return new Error(`${args.label}:${result.reasonCode}`, { cause: result });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
