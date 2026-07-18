import type { ArtifactRuntimePersistenceBridgeResponder } from '../features/assistant/runtime-persistence/artifact-runtime-persistence-types.js';
import {
  ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
  ARTIFACT_RUNTIME_HOST_READY_ACTION,
} from '../features/assistant/runtime-frame/artifact-runtime-host.js';

export const RUNTIME_HOST_ORIGIN = 'http://127.0.0.1:3456';
export const RUNTIME_DOCUMENT =
  '<!doctype html><html><body>runtime</body></html>';
export const SCOPE_HANDLE = 'scope-rev2-message-handler';

export class FakeFrameWindow {
  readonly postedMessages: Array<{ message: unknown; targetOrigin: string }> =
    [];

  postMessage(message: unknown, targetOrigin: string) {
    this.postedMessages.push({ message, targetOrigin });
  }
}

export function createIframeRef(frameWindow: FakeFrameWindow): {
  current: HTMLIFrameElement;
} {
  return {
    current: createIframeElement(frameWindow),
  };
}

export function createIframeElement(
  frameWindow: FakeFrameWindow,
): HTMLIFrameElement {
  return {
    contentWindow: frameWindow,
  } as unknown as HTMLIFrameElement;
}

export function createMessageEvent(args: {
  source: unknown;
  origin?: string;
  data: unknown;
}): MessageEvent<unknown> {
  return {
    source: args.source,
    origin: args.origin ?? RUNTIME_HOST_ORIGIN,
    data: args.data,
  } as MessageEvent<unknown>;
}

export function createReadyMessage() {
  return {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
  };
}

export function createBridgeResponder(
  handleMessage: ArtifactRuntimePersistenceBridgeResponder['handleMessage'] = async () =>
    null,
): ArtifactRuntimePersistenceBridgeResponder {
  return {
    scopeHandle: SCOPE_HANDLE,
    handleMessage,
  };
}
