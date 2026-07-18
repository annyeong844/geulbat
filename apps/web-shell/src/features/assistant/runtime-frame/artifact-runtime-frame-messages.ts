import {
  isArtifactRuntimeHostReadyMessage,
  isArtifactRuntimeHostResizeMessage,
  type ArtifactRuntimeHostReadyMessage,
  type ArtifactRuntimeHostResizeMessage,
} from '@geulbat/protocol/artifact-runtime-host';

import {
  readArtifactRuntimeAgentMessage,
  type ArtifactRuntimeAgentMessage,
} from './artifact-runtime-frame-agent-messages.js';
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
  | ArtifactRuntimeGeneratedExportSnapshotMessage
  | ArtifactRuntimeAgentMessage;

export const MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT = 260;
// 인라인 위젯(visualize)은 카드 캔버스가 아니라 대화 속 삽화다 — 작은
// SVG가 카드 최소 높이(260px)의 빈 여백을 끌고 다니지 않게 별도 하한을 쓴다.
export const MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT = 40;
const MAX_ARTIFACT_RUNTIME_FRAME_HEIGHT = 4096;

export function readArtifactRuntimeFrameMessage(
  value: unknown,
  expectedScopeHandle: string,
  minFrameHeight: number = MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
): ArtifactRuntimeFrameMessage | null {
  const readyMessage = readArtifactRuntimeHostReadyMessage(value);
  if (readyMessage) {
    return {
      kind: 'host_ready',
      message: readyMessage,
    };
  }

  const resizeMessage = readArtifactRuntimeHostResizeMessage(
    value,
    minFrameHeight,
  );
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

  const agentMessage = readArtifactRuntimeAgentMessage(
    value,
    expectedScopeHandle,
  );
  if (agentMessage) {
    return agentMessage;
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
  minFrameHeight: number,
): ArtifactRuntimeHostResizeMessage | null {
  if (!isArtifactRuntimeHostResizeMessage(value)) {
    return null;
  }
  const height = normalizeArtifactRuntimeFrameHeight(
    value['height'],
    minFrameHeight,
  );
  if (height === null) {
    return null;
  }
  return { ...value, height };
}

export function normalizeArtifactRuntimeFrameHeight(
  value: unknown,
  minFrameHeight: number = MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(
    MAX_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    Math.max(minFrameHeight, Math.ceil(value)),
  );
}
