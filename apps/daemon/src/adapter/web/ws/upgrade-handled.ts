import type { IncomingMessage } from 'node:http';

const handledUpgradeRequests = new WeakSet<IncomingMessage>();

export function markUpgradeHandled(req: IncomingMessage): void {
  handledUpgradeRequests.add(req);
}

export function isUpgradeHandled(req: IncomingMessage): boolean {
  return handledUpgradeRequests.has(req);
}
