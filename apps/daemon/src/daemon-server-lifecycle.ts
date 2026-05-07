import type http from 'node:http';
import type { WebSocketServer } from 'ws';

export async function closeDaemonServers(args: {
  server: http.Server;
  webSocketServers: readonly WebSocketServer[];
}): Promise<void> {
  await Promise.all(args.webSocketServers.map(closeWebSocketServer));
  await closeHttpServer(args.server);
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
