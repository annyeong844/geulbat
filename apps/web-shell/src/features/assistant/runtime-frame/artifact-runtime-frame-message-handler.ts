import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import type { ArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence-types.js';
import { createArtifactRuntimeHostBootMessage } from './artifact-runtime-host.js';
import { readArtifactRuntimeFrameMessage } from './artifact-runtime-frame-messages.js';

interface ArtifactRuntimeFrameMessageHandlerArgs {
  iframeRef: { current: HTMLIFrameElement | null };
  runtimeDocument: string;
  runtimeHostOrigin: string;
  scopeHandle: string;
  bridgeResponder: ArtifactRuntimePersistenceBridgeResponder;
  markHostReady: () => void;
  setFrameHeight: (height: number) => void;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}

export function handleArtifactRuntimeFrameMessageEvent(
  event: MessageEvent<unknown>,
  args: ArtifactRuntimeFrameMessageHandlerArgs,
): Promise<void> | void {
  const frameWindow = args.iframeRef.current?.contentWindow;
  if (event.source !== frameWindow || event.origin !== args.runtimeHostOrigin) {
    return;
  }

  const frameMessage = readArtifactRuntimeFrameMessage(
    event.data,
    args.scopeHandle,
  );
  if (frameMessage) {
    switch (frameMessage.kind) {
      case 'host_ready':
        args.markHostReady();
        postRuntimeBootMessage({
          target: event.source,
          runtimeDocument: args.runtimeDocument,
          runtimeHostOrigin: args.runtimeHostOrigin,
        });
        break;
      case 'host_resize':
        args.setFrameHeight(frameMessage.height);
        break;
      case 'generated_binary_export_snapshot':
        args.onGeneratedBinaryExportSnapshotChange?.(frameMessage.snapshot);
        break;
      case 'generated_text_export_snapshot':
        args.onGeneratedTextExportSnapshotChange?.(frameMessage.snapshot);
        break;
    }
    return;
  }

  return args.bridgeResponder
    .handleMessage(event.source, event.data)
    .then((response) => {
      const currentFrameWindow = args.iframeRef.current?.contentWindow;
      if (
        !response ||
        event.source !== currentFrameWindow ||
        !isPostMessageTarget(event.source)
      ) {
        return;
      }
      event.source.postMessage(response, args.runtimeHostOrigin);
    });
}

function postRuntimeBootMessage(args: {
  target: MessageEventSource | null;
  runtimeDocument: string;
  runtimeHostOrigin: string;
}) {
  if (!isPostMessageTarget(args.target)) {
    return;
  }
  args.target.postMessage(
    createArtifactRuntimeHostBootMessage(args.runtimeDocument),
    args.runtimeHostOrigin,
  );
}

function isPostMessageTarget(
  value: MessageEventSource | null,
): value is MessageEventSource & {
  postMessage: (message: unknown, targetOrigin: string) => void;
} {
  return value !== null && 'postMessage' in value;
}
