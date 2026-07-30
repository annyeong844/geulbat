import {
  DAEMON_LIFECYCLE_READY_MESSAGE_TYPE,
  type DaemonLifecycleReadyMessage,
} from './protocol.js';

export async function notifyDaemonLifecycleReady(): Promise<void> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    throw new Error('daemon child requires a lifecycle worker IPC channel');
  }
  const message: DaemonLifecycleReadyMessage = {
    type: DAEMON_LIFECYCLE_READY_MESSAGE_TYPE,
  };
  await new Promise<void>((resolve, reject) => {
    send(message, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}
