import {
  isProjectId,
  isThreadId,
  type ProjectId,
  type ThreadId,
} from './ids.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

export const ARTIFACT_RENDERERS = [
  'markdown',
  'code',
  'diff',
  'table',
  'html5',
  'js',
  'react_bundle',
] as const;

export type ArtifactRenderer = (typeof ARTIFACT_RENDERERS)[number];

export const ARTIFACT_START_PREFIX = '<!-- GEULBAT_ARTIFACT ';
export const ARTIFACT_END_MARKER = '<!-- /GEULBAT_ARTIFACT -->';

// Artifact ids are daemon-generated persistence keys, not canonical user-facing ids.
// Keep them unbranded until artifact storage has a first-class protocol boundary.
export type ArtifactId = string;

// Artifact-linked run ids are replay/persistence metadata today.
// Keep them unbranded while transcript/history surfaces still carry legacy string truth.
export type ArtifactRunId = string;

export interface ArtifactRef {
  artifactId: ArtifactId;
  version: number;
}

interface ArtifactSourceRefBase {
  projectId: ProjectId;
  threadId: ThreadId;
  runId: ArtifactRunId | null;
  messageTimestamp: string | null;
}

export interface ArtifactThreadSourceRef extends ArtifactSourceRefBase {
  kind: 'thread';
  filePath: null;
}

export interface ArtifactThreadFileSourceRef extends ArtifactSourceRefBase {
  kind: 'thread-file';
  filePath: string;
}

export type ArtifactSourceRef =
  | ArtifactThreadSourceRef
  | ArtifactThreadFileSourceRef;

export interface ArtifactRecord {
  artifactId: ArtifactId;
  projectId: ProjectId;
  threadId: ThreadId;
  renderer: ArtifactRenderer;
  title: string | null;
  sourceRef: ArtifactSourceRef | null;
  latestVersion: number;
  persistenceEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionRecord {
  artifactId: ArtifactId;
  version: number;
  parentVersion: number | null;
  baseVersion: number | null;
  renderer: ArtifactRenderer;
  payload: string;
  digest: string | null;
  contentHash: string;
  createdAt: string;
  createdByRunId: ArtifactRunId;
  previewValidation: ArtifactPreviewValidation;
}

export interface ThreadArtifactVersion extends ArtifactVersionRecord {
  title: string | null;
  persistenceEpoch: number;
  sourceRef: ArtifactSourceRef | null;
}

export type ArtifactPreviewValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: string;
      detail: string;
    };

export function isArtifactRenderer(value: unknown): value is ArtifactRenderer {
  return (
    typeof value === 'string' &&
    (ARTIFACT_RENDERERS as readonly string[]).includes(value)
  );
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0
  );
}

export function isArtifactSourceRef(
  value: unknown,
): value is ArtifactSourceRef {
  if (!isRecord(value)) {
    return false;
  }

  const projectId = readRequiredProjectId(value.projectId);
  const threadId = readRequiredThreadId(value.threadId);
  if (
    projectId === null ||
    threadId === null ||
    (value.runId !== null && !isString(value.runId)) ||
    (value.messageTimestamp !== null && !isString(value.messageTimestamp))
  ) {
    return false;
  }

  if (value.kind === 'thread') {
    return value.filePath === null;
  }

  return (
    value.kind === 'thread-file' &&
    isString(value.filePath) &&
    value.filePath.trim() !== ''
  );
}

export function normalizeArtifactSourceRef(
  value: unknown,
): ArtifactSourceRef | null {
  if (!isRecord(value)) {
    return null;
  }

  const projectId = readRequiredProjectId(value.projectId);
  const threadId = readRequiredThreadId(value.threadId);
  const runId = readNullableString(value.runId);
  const messageTimestamp = readNullableString(value.messageTimestamp);
  if (
    projectId === null ||
    threadId === null ||
    runId === undefined ||
    messageTimestamp === undefined
  ) {
    return null;
  }

  if (value.kind === 'thread') {
    const filePath = readNullableString(value.filePath);
    if (filePath === undefined || filePath !== null) {
      return null;
    }
    return {
      kind: 'thread',
      projectId,
      threadId,
      runId,
      filePath: null,
      messageTimestamp,
    };
  }

  if (value.kind === 'thread-file') {
    if (!isString(value.filePath) || value.filePath.trim() === '') {
      return null;
    }
    return {
      kind: 'thread-file',
      projectId,
      threadId,
      runId,
      filePath: value.filePath,
      messageTimestamp,
    };
  }

  const legacyFilePath = readNullableString(value.filePath);
  if (legacyFilePath === undefined) {
    return null;
  }
  if (legacyFilePath !== null && legacyFilePath.trim() !== '') {
    return {
      kind: 'thread-file',
      projectId,
      threadId,
      runId,
      filePath: legacyFilePath,
      messageTimestamp,
    };
  }

  return {
    kind: 'thread',
    projectId,
    threadId,
    runId,
    filePath: null,
    messageTimestamp,
  };
}

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    isString(value.projectId) &&
    isProjectId(value.projectId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isArtifactRenderer(value.renderer) &&
    isNullableString(value.title) &&
    (value.sourceRef === null || isArtifactSourceRef(value.sourceRef)) &&
    isNumber(value.latestVersion) &&
    Number.isInteger(value.latestVersion) &&
    value.latestVersion > 0 &&
    isNumber(value.persistenceEpoch) &&
    Number.isInteger(value.persistenceEpoch) &&
    value.persistenceEpoch >= 0 &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export function isArtifactVersionRecord(
  value: unknown,
): value is ArtifactVersionRecord {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    value.artifactId.trim() !== '' &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    isNullableInteger(value.parentVersion) &&
    isNullableInteger(value.baseVersion) &&
    isArtifactRenderer(value.renderer) &&
    isString(value.payload) &&
    isNullableString(value.digest) &&
    isString(value.contentHash) &&
    value.contentHash.trim() !== '' &&
    isString(value.createdAt) &&
    isString(value.createdByRunId) &&
    isPreviewValidation(value.previewValidation)
  );
}

export function isThreadArtifactVersion(
  value: unknown,
): value is ThreadArtifactVersion {
  return (
    isArtifactVersionRecord(value) &&
    isRecord(value) &&
    isNullableString(value.title) &&
    isNumber(value.persistenceEpoch) &&
    Number.isInteger(value.persistenceEpoch) &&
    value.persistenceEpoch >= 0 &&
    (value.sourceRef === null || isArtifactSourceRef(value.sourceRef))
  );
}

export function createArtifactRefKey(ref: ArtifactRef): string {
  return `${ref.artifactId}::${ref.version}`;
}

export interface ParsedCanonicalArtifactEnvelope {
  renderer: ArtifactRenderer;
  payload: string;
  digest: string | null;
}

export function buildArtifactEnvelopeText(args: {
  renderer: ArtifactRenderer;
  digest?: string | null;
  payload: string;
}): string {
  const header: {
    renderer: ArtifactRenderer;
    digest?: string;
  } = {
    renderer: args.renderer,
  };
  if (typeof args.digest === 'string' && args.digest.trim()) {
    header.digest = args.digest.trim();
  }
  return [
    `${ARTIFACT_START_PREFIX}${JSON.stringify(header)} -->`,
    args.payload,
    ARTIFACT_END_MARKER,
  ].join('\n');
}

export function parseCanonicalArtifactEnvelopeText(
  value: string,
): ParsedCanonicalArtifactEnvelope | null {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith(ARTIFACT_START_PREFIX) ||
    !trimmed.endsWith(ARTIFACT_END_MARKER)
  ) {
    return null;
  }

  const headerEnd = trimmed.indexOf('-->');
  if (headerEnd === -1) {
    return null;
  }

  const headerJson = trimmed
    .slice(ARTIFACT_START_PREFIX.length, headerEnd)
    .trim();
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(headerJson);
  } catch {
    return null;
  }

  if (!isRecord(parsedHeader) || !isArtifactRenderer(parsedHeader.renderer)) {
    return null;
  }

  return {
    renderer: parsedHeader.renderer,
    payload: trimmed.slice(headerEnd + 3, -ARTIFACT_END_MARKER.length),
    digest:
      typeof parsedHeader.digest === 'string' && parsedHeader.digest.trim()
        ? parsedHeader.digest.trim()
        : null,
  };
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || isString(value);
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (isString(value)) {
    return value;
  }
  return undefined;
}

function readRequiredProjectId(value: unknown): ProjectId | null {
  return isString(value) && isProjectId(value) ? value : null;
}

function readRequiredThreadId(value: unknown): ThreadId | null {
  return isString(value) && isThreadId(value) ? value : null;
}

function isNullableInteger(value: unknown): value is number | null {
  return (
    value === null || (isNumber(value) && Number.isInteger(value) && value > 0)
  );
}

function isPreviewValidation(
  value: unknown,
): value is ArtifactVersionRecord['previewValidation'] {
  return (
    isRecord(value) &&
    ((value.ok === true &&
      value.code === undefined &&
      value.detail === undefined) ||
      (value.ok === false && isString(value.code) && isString(value.detail)))
  );
}
