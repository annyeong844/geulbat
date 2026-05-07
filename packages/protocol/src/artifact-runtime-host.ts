import { isNumber, isRecord, isString } from './runtime-utils.js';

export const ARTIFACT_RUNTIME_HOST_MESSAGE_KIND =
  'geulbat.artifact_runtime_host';
export const ARTIFACT_RUNTIME_HOST_BOOT_ACTION = 'boot';
export const ARTIFACT_RUNTIME_HOST_READY_ACTION = 'ready';
export const ARTIFACT_RUNTIME_HOST_RESIZE_ACTION = 'resize';
export const DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN = 'http://127.0.0.1:3456';

export interface ArtifactRuntimeHostBootMessage {
  kind: typeof ARTIFACT_RUNTIME_HOST_MESSAGE_KIND;
  action: typeof ARTIFACT_RUNTIME_HOST_BOOT_ACTION;
  documentHtml: string;
}

export interface ArtifactRuntimeHostReadyMessage {
  kind: typeof ARTIFACT_RUNTIME_HOST_MESSAGE_KIND;
  action: typeof ARTIFACT_RUNTIME_HOST_READY_ACTION;
}

export interface ArtifactRuntimeHostResizeMessage {
  kind: typeof ARTIFACT_RUNTIME_HOST_MESSAGE_KIND;
  action: typeof ARTIFACT_RUNTIME_HOST_RESIZE_ACTION;
  height: number;
}

export type ArtifactRuntimeHostMessage =
  | ArtifactRuntimeHostBootMessage
  | ArtifactRuntimeHostReadyMessage
  | ArtifactRuntimeHostResizeMessage;

export function createArtifactRuntimeHostBootMessage(
  documentHtml: string,
): ArtifactRuntimeHostBootMessage {
  return {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_BOOT_ACTION,
    documentHtml,
  };
}

export function createArtifactRuntimeHostReadyMessage(): ArtifactRuntimeHostReadyMessage {
  return {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_READY_ACTION,
  };
}

export function createArtifactRuntimeHostResizeMessage(
  height: number,
): ArtifactRuntimeHostResizeMessage {
  return {
    kind: ARTIFACT_RUNTIME_HOST_MESSAGE_KIND,
    action: ARTIFACT_RUNTIME_HOST_RESIZE_ACTION,
    height,
  };
}

export function isArtifactRuntimeHostBootMessage(
  value: unknown,
): value is ArtifactRuntimeHostBootMessage {
  return (
    isRecord(value) &&
    value.kind === ARTIFACT_RUNTIME_HOST_MESSAGE_KIND &&
    value.action === ARTIFACT_RUNTIME_HOST_BOOT_ACTION &&
    isString(value.documentHtml)
  );
}

export function isArtifactRuntimeHostReadyMessage(
  value: unknown,
): value is ArtifactRuntimeHostReadyMessage {
  return (
    isRecord(value) &&
    value.kind === ARTIFACT_RUNTIME_HOST_MESSAGE_KIND &&
    value.action === ARTIFACT_RUNTIME_HOST_READY_ACTION
  );
}

export function isArtifactRuntimeHostResizeMessage(
  value: unknown,
): value is ArtifactRuntimeHostResizeMessage {
  return (
    isRecord(value) &&
    value.kind === ARTIFACT_RUNTIME_HOST_MESSAGE_KIND &&
    value.action === ARTIFACT_RUNTIME_HOST_RESIZE_ACTION &&
    isNumber(value.height)
  );
}

export function isArtifactRuntimeHostMessage(
  value: unknown,
): value is ArtifactRuntimeHostMessage {
  return (
    isArtifactRuntimeHostBootMessage(value) ||
    isArtifactRuntimeHostReadyMessage(value) ||
    isArtifactRuntimeHostResizeMessage(value)
  );
}
