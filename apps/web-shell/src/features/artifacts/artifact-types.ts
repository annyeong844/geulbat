import type {
  ArtifactId,
  ArtifactRunId,
  ArtifactSourceRef,
} from '@geulbat/protocol/artifacts';
import type { ReactBundleInlineCompileFailureCode } from '@geulbat/protocol/react-bundle-inline-compile';
import { isThreadId, type ThreadId } from '@geulbat/protocol/ids';
import { isRecord } from '../../lib/json.js';
import type { ReactNode } from 'react';
import type { ArtifactDurabilitySourceAuthority } from './artifact-durability-source-authority.js';

export type ArtifactParseResult =
  | {
      kind: 'none';
      raw: string;
    }
  | {
      kind: 'artifact';
      state: 'streaming' | 'completed' | 'fallback';
      renderer: string | null;
      digest: string | null;
      payload: string;
      raw: string;
      issue?: string;
    };

export type ArtifactOnlyParseResult = Extract<
  ArtifactParseResult,
  { kind: 'artifact' }
>;

export interface ArtifactSourceInputRef {
  kind?: ArtifactSourceRef['kind'] | null;
  workingDirectory?: string | null;
  threadId?: string | null;
  runId?: string | null;
  filePath?: string | null;
  messageTimestamp?: string | null;
  artifactId?: string | null;
  artifactVersion?: number | null;
  persistenceEpoch?: number | null;
}

export interface ResolvedArtifactSourceRef {
  kind: ArtifactSourceRef['kind'] | null;
  workingDirectory: string;
  threadId: ThreadId | null;
  runId: ArtifactRunId | null;
  filePath: string | null;
  messageTimestamp: string | null;
  artifactId: ArtifactId | null;
  artifactVersion: number | null;
  persistenceEpoch: number | null;
}

const GENERATED_TEXT_EXPORT_MIME_TYPES = [
  'text/plain',
  'text/html',
  'text/css',
  'application/json',
  'image/svg+xml',
  'text/markdown',
] as const;

type GeneratedTextExportMimeType =
  (typeof GENERATED_TEXT_EXPORT_MIME_TYPES)[number];

export interface GeneratedTextExportSnapshot {
  content: string;
  mimeType: GeneratedTextExportMimeType;
  fileNameHint: string | null;
}

export interface GeneratedBinaryExportSnapshot {
  blob: Blob;
  fileNameHint: string | null;
}

type ArtifactRuntimeErrorCode = ReactBundleInlineCompileFailureCode;

export type ArtifactValidationSuccess<TShape extends object = object> = {
  ok: true;
} & TShape;

export interface ArtifactValidationFailure<
  TCode extends ArtifactRuntimeErrorCode = ArtifactRuntimeErrorCode,
> {
  ok: false;
  code: TCode;
  detail: string;
}

export type ArtifactSanitizeRejectedFailure =
  ArtifactValidationFailure<'sanitize_rejected'>;
export type ArtifactBootFailure = ArtifactValidationFailure<'boot_failed'>;
export type ArtifactPolicyOrBootFailure = ArtifactValidationFailure<
  'policy_blocked' | 'boot_failed'
>;
export type ArtifactRuntimeIssue<
  TCode extends ArtifactRuntimeErrorCode = ArtifactRuntimeErrorCode,
> = Pick<ArtifactValidationFailure<TCode>, 'code' | 'detail'>;

export type ArtifactPreviewSurface =
  | {
      kind: 'rendered';
      node: ReactNode;
    }
  | {
      kind: 'pending';
      detail: string;
    }
  | {
      kind: 'unavailable';
      code: ArtifactRuntimeErrorCode;
      detail: string;
    };

interface ArtifactActionState {
  visible: boolean;
  enabled: boolean;
  reason: string | null;
}

export interface ArtifactViewModel {
  parsed: ArtifactParseResult;
  sourceRef: ResolvedArtifactSourceRef;
  sourceAuthority: ArtifactDurabilitySourceAuthority | null;
  actions: {
    apply: ArtifactActionState;
    export: ArtifactActionState;
  };
}

export type ArtifactOnlyViewModel = ArtifactViewModel & {
  parsed: ArtifactOnlyParseResult;
};

export function sanitizeArtifactSourceInputRef(
  sourceRef: ArtifactSourceInputRef | ResolvedArtifactSourceRef | undefined,
): ResolvedArtifactSourceRef {
  const workingDirectory = readWorkingDirectory(sourceRef?.workingDirectory);
  const threadId = readThreadId(sourceRef?.threadId);
  const filePath = readNonEmptyString(sourceRef?.filePath);
  return {
    kind: readArtifactSourceRefKind(sourceRef?.kind, {
      threadId,
      filePath,
    }),
    workingDirectory,
    threadId,
    runId: readArtifactRunId(sourceRef?.runId),
    filePath,
    messageTimestamp: readNonEmptyString(sourceRef?.messageTimestamp),
    artifactId: readArtifactId(sourceRef?.artifactId),
    artifactVersion: readNonNegativeInteger(sourceRef?.artifactVersion),
    persistenceEpoch: readNonNegativeInteger(sourceRef?.persistenceEpoch),
  };
}

function readArtifactSourceRefKind(
  value: ArtifactSourceRef['kind'] | null | undefined,
  sourceRef: {
    threadId: ThreadId | null;
    filePath: string | null;
  },
): ArtifactSourceRef['kind'] | null {
  if (value === 'thread' || value === 'thread-file') {
    return value;
  }
  if (!sourceRef.threadId) {
    return null;
  }
  return sourceRef.filePath ? 'thread-file' : 'thread';
}

function isSupportedGeneratedTextExportMimeType(
  value: string,
): value is GeneratedTextExportMimeType {
  return GENERATED_TEXT_EXPORT_MIME_TYPES.some(
    (mimeType) => mimeType === value,
  );
}

export function sanitizeGeneratedTextExportFileNameHint(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function sanitizeGeneratedTextExportSnapshot(
  value: unknown,
): GeneratedTextExportSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  if (
    typeof record['content'] !== 'string' ||
    typeof record['mimeType'] !== 'string' ||
    !isSupportedGeneratedTextExportMimeType(record['mimeType'])
  ) {
    return null;
  }

  return {
    content: record['content'],
    mimeType: record['mimeType'],
    fileNameHint: sanitizeGeneratedTextExportFileNameHint(
      typeof record['fileNameHint'] === 'string'
        ? record['fileNameHint']
        : null,
    ),
  };
}

export function sanitizeGeneratedBinaryExportSnapshot(
  value: unknown,
): GeneratedBinaryExportSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const blob = record['blob'];
  if (!isBlobInstance(blob)) {
    return null;
  }
  const explicitFileNameHint = sanitizeGeneratedTextExportFileNameHint(
    typeof record['fileNameHint'] === 'string' ? record['fileNameHint'] : null,
  );
  return {
    blob,
    fileNameHint:
      explicitFileNameHint ?? readGeneratedBinaryBlobFileNameHint(blob),
  };
}

export function renderedArtifactPreview(
  node: ReactNode,
): ArtifactPreviewSurface {
  return {
    kind: 'rendered',
    node,
  };
}

export function unavailableArtifactPreview(
  code: ArtifactRuntimeErrorCode,
  detail: string,
): ArtifactPreviewSurface {
  return {
    kind: 'unavailable',
    code,
    detail,
  };
}

export function pendingArtifactPreview(detail: string): ArtifactPreviewSurface {
  return {
    kind: 'pending',
    detail,
  };
}

function readNonEmptyString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readWorkingDirectory(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function readThreadId(value: string | null | undefined): ThreadId | null {
  return typeof value === 'string' && isThreadId(value) ? value : null;
}

function readArtifactRunId(
  value: string | null | undefined,
): ArtifactRunId | null {
  const runId = readNonEmptyString(value);
  return runId as ArtifactRunId | null;
}

function readArtifactId(value: string | null | undefined): ArtifactId | null {
  const artifactId = readNonEmptyString(value);
  return artifactId as ArtifactId | null;
}

function readNonNegativeInteger(
  value: number | null | undefined,
): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isBlobInstance(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function readGeneratedBinaryBlobFileNameHint(blob: Blob): string | null {
  if (typeof File === 'undefined' || !(blob instanceof File)) {
    return null;
  }
  return sanitizeGeneratedTextExportFileNameHint(blob.name);
}
