import {
  isArtifactRuntimeHostReadyMessage,
  isArtifactRuntimeHostResizeMessage,
  type ArtifactRuntimeHostReadyMessage,
  type ArtifactRuntimeHostResizeMessage,
} from '@geulbat/protocol/artifact-runtime-host';

import {
  readArtifactRuntimeGeneratedExportSnapshotMessage,
  type ArtifactRuntimeGeneratedExportSnapshotMessage,
} from './artifact-runtime-frame-generated-export-messages.js';

type ArtifactRuntimeFrameMessage =
  | {
      kind: 'host_ready';
      message: ArtifactRuntimeHostReadyMessage;
    }
  | {
      kind: 'host_resize';
      height: number;
      message: ArtifactRuntimeHostResizeMessage;
    }
  | ArtifactRuntimeGeneratedExportSnapshotMessage;

export const MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT = 260;
const MAX_ARTIFACT_RUNTIME_FRAME_HEIGHT = 4096;

export function readArtifactRuntimeFrameMessage(
  value: unknown,
  expectedScopeHandle: string,
): ArtifactRuntimeFrameMessage | null {
  const readyMessage = readArtifactRuntimeHostReadyMessage(value);
  if (readyMessage) {
    return {
      kind: 'host_ready',
      message: readyMessage,
    };
  }

  const resizeMessage = readArtifactRuntimeHostResizeMessage(value);
  if (resizeMessage) {
    return {
      kind: 'host_resize',
      height: resizeMessage.height,
      message: resizeMessage,
    };
  }

  const generatedExportSnapshotMessage =
    readArtifactRuntimeGeneratedExportSnapshotMessage(
      value,
      expectedScopeHandle,
    );
  if (generatedExportSnapshotMessage) {
    return generatedExportSnapshotMessage;
  }

  return null;
}

function readArtifactRuntimeHostReadyMessage(
  value: unknown,
): ArtifactRuntimeHostReadyMessage | null {
  return isArtifactRuntimeHostReadyMessage(value) ? value : null;
}

function readArtifactRuntimeHostResizeMessage(
  value: unknown,
): ArtifactRuntimeHostResizeMessage | null {
  if (!isArtifactRuntimeHostResizeMessage(value)) {
    return null;
  }
  const height = normalizeArtifactRuntimeFrameHeight(value['height']);
  if (height === null) {
    return null;
  }
  return { ...value, height };
}

export function normalizeArtifactRuntimeFrameHeight(
  value: unknown,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(
    MAX_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    Math.max(MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT, Math.ceil(value)),
  );
}
