import type http from 'node:http';
import type { WebSocketServer } from 'ws';
import { getErrorMessage } from './daemon/utils/error.js';

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
  computerDirectoryPicker: { close(): Promise<void> };
  globalMcp: DaemonMcpRuntimeCloser;
  ptcBrowserPageLoadEvidence: DaemonRuntimeSessionCloser;
  ptcBrowserTextEvidence: DaemonRuntimeSessionCloser;
  ptcBrowserNavigate: DaemonRuntimeSessionCloser;
  ptcExecuteCode: DaemonRuntimeSessionCloser;
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
      | 'runtimeSessions'
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
  await attempt('runtimeSessions', async () => {
    const results = await collectDaemonBackgroundRuntimeSessionResults({
      runtimeSessions: args.runtimeSessions,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    throwForRuntimeSessionFailures(results);
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

export function listenDaemonHttpServer(args: {
  server: http.Server;
  port: number;
  host: string;
}): Promise<void> {
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
      resolve();
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

export async function closeDaemonRuntimeSessions(args: {
  runtimeSessions: DaemonRuntimeSessionClosers;
  signal?: AbortSignal;
}): Promise<void> {
  const [pickerResult, backgroundResults] = await Promise.all([
    closeComputerDirectoryPicker(args.runtimeSessions.computerDirectoryPicker),
    collectDaemonBackgroundRuntimeSessionResults(args),
  ]);
  throwForRuntimeSessionFailures([pickerResult, ...backgroundResults]);
}

async function collectDaemonBackgroundRuntimeSessionResults(args: {
  runtimeSessions: DaemonRuntimeSessionClosers;
  signal?: AbortSignal;
}): Promise<ReadonlyArray<{ failure?: string }>> {
  return await Promise.all([
    closeDaemonMcpRuntime({
      runtime: args.runtimeSessions.globalMcp,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserPageLoadEvidence',
      runtime: args.runtimeSessions.ptcBrowserPageLoadEvidence,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserTextEvidence',
      runtime: args.runtimeSessions.ptcBrowserTextEvidence,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcBrowserNavigate',
      runtime: args.runtimeSessions.ptcBrowserNavigate,
      signal: args.signal,
    }),
    closeDaemonRuntimeSession({
      label: 'ptcExecuteCode',
      runtime: args.runtimeSessions.ptcExecuteCode,
      signal: args.signal,
    }),
  ]);
}

function throwForRuntimeSessionFailures(
  results: ReadonlyArray<{ failure?: string }>,
): void {
  const failures = results
    .map((result) => result.failure)
    .filter((failure): failure is string => typeof failure === 'string');
  if (failures.length > 0) {
    throw new Error(
      `daemon runtime session cleanup failed: ${failures.join('; ')}`,
    );
  }
}

async function closeComputerDirectoryPicker(
  picker: DaemonRuntimeSessionClosers['computerDirectoryPicker'],
): Promise<{ failure?: string }> {
  try {
    await picker.close();
    return {};
  } catch {
    return { failure: 'computerDirectoryPicker:threw' };
  }
}

async function closeDaemonMcpRuntime(args: {
  runtime: DaemonMcpRuntimeCloser;
  signal: AbortSignal | undefined;
}): Promise<{ failure?: string }> {
  try {
    await args.runtime.close(
      args.signal === undefined ? undefined : { signal: args.signal },
    );
    return {};
  } catch {
    return { failure: 'globalMcp:threw' };
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
}): Promise<{ failure?: string }> {
  let result: DaemonRuntimeSessionCleanupResult;
  try {
    result = await args.runtime.closeAll(
      args.signal === undefined ? undefined : { signal: args.signal },
    );
  } catch {
    return { failure: `${args.label}:threw` };
  }
  if (result.ok) {
    return {};
  }
  return {
    failure: `${args.label}:${result.reasonCode}`,
  };
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
