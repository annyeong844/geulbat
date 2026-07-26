import { isRecord } from '../../../lib/json.js';

import {
  sanitizeGeneratedBinaryExportSnapshot,
  sanitizeGeneratedTextExportSnapshot,
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';

const GENERATED_TEXT_EXPORT_MESSAGE_KIND =
  'geulbat.runtime.generated_text_export';
const GENERATED_BINARY_EXPORT_MESSAGE_KIND =
  'geulbat.runtime.generated_binary_export';

type GeneratedExportSnapshotMessage<MessageKind extends string, Snapshot> =
  | {
      kind: MessageKind;
      scopeHandle: string;
      action: 'set_snapshot';
      snapshot: Snapshot;
    }
  | {
      kind: MessageKind;
      scopeHandle: string;
      action: 'clear_snapshot';
    };

export type ArtifactRuntimeGeneratedExportSnapshotMessage =
  | {
      kind: 'generated_text_export_snapshot';
      snapshot: GeneratedTextExportSnapshot | null;
    }
  | {
      kind: 'generated_binary_export_snapshot';
      snapshot: GeneratedBinaryExportSnapshot | null;
    };

export function readArtifactRuntimeGeneratedExportSnapshotMessage(
  value: unknown,
  expectedScopeHandle: string,
): ArtifactRuntimeGeneratedExportSnapshotMessage | null {
  const binarySnapshotMessage = readGeneratedExportSnapshotMessage(
    value,
    expectedScopeHandle,
    GENERATED_BINARY_EXPORT_MESSAGE_KIND,
    sanitizeGeneratedBinaryExportSnapshot,
  );
  if (binarySnapshotMessage) {
    return {
      kind: 'generated_binary_export_snapshot',
      snapshot:
        binarySnapshotMessage.action === 'set_snapshot'
          ? binarySnapshotMessage.snapshot
          : null,
    };
  }

  const textSnapshotMessage = readGeneratedExportSnapshotMessage(
    value,
    expectedScopeHandle,
    GENERATED_TEXT_EXPORT_MESSAGE_KIND,
    sanitizeGeneratedTextExportSnapshot,
  );
  if (textSnapshotMessage) {
    return {
      kind: 'generated_text_export_snapshot',
      snapshot:
        textSnapshotMessage.action === 'set_snapshot'
          ? textSnapshotMessage.snapshot
          : null,
    };
  }

  return null;
}

function readGeneratedExportSnapshotMessage<
  MessageKind extends string,
  Snapshot,
>(
  value: unknown,
  expectedScopeHandle: string,
  messageKind: MessageKind,
  sanitizeSnapshot: (value: unknown) => Snapshot | null,
): GeneratedExportSnapshotMessage<MessageKind, Snapshot> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value['kind'] !== messageKind ||
    value['scopeHandle'] !== expectedScopeHandle ||
    (value['action'] !== 'set_snapshot' && value['action'] !== 'clear_snapshot')
  ) {
    return null;
  }
  if (value['action'] === 'clear_snapshot') {
    return {
      kind: messageKind,
      scopeHandle: expectedScopeHandle,
      action: 'clear_snapshot',
    };
  }
  const snapshot = sanitizeSnapshot(value['snapshot']);
  if (snapshot === null) {
    return null;
  }
  return {
    kind: messageKind,
    scopeHandle: expectedScopeHandle,
    action: 'set_snapshot',
    snapshot,
  };
}
