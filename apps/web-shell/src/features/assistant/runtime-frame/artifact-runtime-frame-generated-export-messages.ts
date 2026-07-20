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

type GeneratedTextExportSnapshotMessage =
  | {
      kind: typeof GENERATED_TEXT_EXPORT_MESSAGE_KIND;
      scopeHandle: string;
      action: 'set_snapshot';
      snapshot: GeneratedTextExportSnapshot;
    }
  | {
      kind: typeof GENERATED_TEXT_EXPORT_MESSAGE_KIND;
      scopeHandle: string;
      action: 'clear_snapshot';
    };

type GeneratedBinaryExportSnapshotMessage =
  | {
      kind: typeof GENERATED_BINARY_EXPORT_MESSAGE_KIND;
      scopeHandle: string;
      action: 'set_snapshot';
      snapshot: GeneratedBinaryExportSnapshot;
    }
  | {
      kind: typeof GENERATED_BINARY_EXPORT_MESSAGE_KIND;
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
  const binarySnapshotMessage = readGeneratedBinaryExportSnapshotMessage(
    value,
    expectedScopeHandle,
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

  const textSnapshotMessage = readGeneratedTextExportSnapshotMessage(
    value,
    expectedScopeHandle,
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

function readGeneratedTextExportSnapshotMessage(
  value: unknown,
  expectedScopeHandle: string,
): GeneratedTextExportSnapshotMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value['kind'] !== GENERATED_TEXT_EXPORT_MESSAGE_KIND ||
    value['scopeHandle'] !== expectedScopeHandle ||
    (value['action'] !== 'set_snapshot' && value['action'] !== 'clear_snapshot')
  ) {
    return null;
  }
  if (value['action'] === 'clear_snapshot') {
    return {
      kind: GENERATED_TEXT_EXPORT_MESSAGE_KIND,
      scopeHandle: expectedScopeHandle,
      action: 'clear_snapshot',
    };
  }
  const snapshot = sanitizeGeneratedTextExportSnapshot(value['snapshot']);
  if (!snapshot) {
    return null;
  }
  return {
    kind: GENERATED_TEXT_EXPORT_MESSAGE_KIND,
    scopeHandle: expectedScopeHandle,
    action: 'set_snapshot',
    snapshot,
  };
}

function readGeneratedBinaryExportSnapshotMessage(
  value: unknown,
  expectedScopeHandle: string,
): GeneratedBinaryExportSnapshotMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value['kind'] !== GENERATED_BINARY_EXPORT_MESSAGE_KIND ||
    value['scopeHandle'] !== expectedScopeHandle ||
    (value['action'] !== 'set_snapshot' && value['action'] !== 'clear_snapshot')
  ) {
    return null;
  }
  if (value['action'] === 'clear_snapshot') {
    return {
      kind: GENERATED_BINARY_EXPORT_MESSAGE_KIND,
      scopeHandle: expectedScopeHandle,
      action: 'clear_snapshot',
    };
  }
  const snapshot = sanitizeGeneratedBinaryExportSnapshot(value['snapshot']);
  if (!snapshot) {
    return null;
  }
  return {
    kind: GENERATED_BINARY_EXPORT_MESSAGE_KIND,
    scopeHandle: expectedScopeHandle,
    action: 'set_snapshot',
    snapshot,
  };
}
