import { isArtifactRef, type ArtifactRef } from './artifacts.js';
import { isRecord, isString } from './runtime-utils.js';

export const THREAD_MESSAGE_PHASES = ['commentary', 'final_answer'] as const;

export type ThreadMessagePhase = (typeof THREAD_MESSAGE_PHASES)[number];

export interface UserThreadMessageMetadata {
  hiddenPrompt: string;
  source?: never;
  phase?: never;
  sourceRunId?: never;
  sourceFile?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

export interface CommentaryThreadMessageMetadata {
  phase: 'commentary';
  sourceRunId?: string;
  sourceFile?: string;
  source?: never;
  hiddenPrompt?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

export interface FinalAnswerThreadMessageMetadata {
  phase: 'final_answer';
  sourceRunId?: string;
  sourceFile?: string;
  artifactRefs?: ArtifactRef[];
  activeArtifactRef?: ArtifactRef;
  source?: never;
  hiddenPrompt?: never;
}

export interface InterjectThreadMessageMetadata {
  source: 'interject';
  phase?: never;
  hiddenPrompt?: never;
  sourceRunId?: never;
  sourceFile?: never;
  artifactRefs?: never;
  activeArtifactRef?: never;
}

export type ThreadMessageMetadata =
  | UserThreadMessageMetadata
  | CommentaryThreadMessageMetadata
  | FinalAnswerThreadMessageMetadata
  | InterjectThreadMessageMetadata;

const USER_METADATA_KEYS = ['hiddenPrompt'] as const;
const COMMENTARY_METADATA_KEYS = [
  'phase',
  'sourceRunId',
  'sourceFile',
] as const;
const FINAL_ANSWER_METADATA_KEYS = [
  'phase',
  'sourceRunId',
  'sourceFile',
  'artifactRefs',
  'activeArtifactRef',
] as const;
const INTERJECT_METADATA_KEYS = ['source'] as const;

export function isThreadMessagePhase(
  value: unknown,
): value is ThreadMessagePhase {
  return (
    typeof value === 'string' &&
    (THREAD_MESSAGE_PHASES as readonly string[]).includes(value)
  );
}

export function isThreadMessageMetadata(
  value: unknown,
): value is ThreadMessageMetadata {
  if (!isRecord(value)) {
    return false;
  }

  if (value.source === 'interject') {
    return hasOnlyMetadataKeys(value, INTERJECT_METADATA_KEYS);
  }

  if (value.phase === undefined) {
    return (
      hasOnlyMetadataKeys(value, USER_METADATA_KEYS) &&
      isString(value.hiddenPrompt)
    );
  }

  if (value.phase === 'commentary') {
    return (
      hasOnlyMetadataKeys(value, COMMENTARY_METADATA_KEYS) &&
      isOptionalString(value.sourceRunId) &&
      isOptionalString(value.sourceFile)
    );
  }

  return (
    value.phase === 'final_answer' &&
    hasOnlyMetadataKeys(value, FINAL_ANSWER_METADATA_KEYS) &&
    isOptionalString(value.sourceRunId) &&
    isOptionalString(value.sourceFile) &&
    isOptionalArtifactRefs(value.artifactRefs) &&
    isOptionalArtifactRef(value.activeArtifactRef)
  );
}

export function readArtifactRefsFromMetadata(
  metadata: ThreadMessageMetadata | undefined,
): ArtifactRef[] {
  return metadata?.artifactRefs ?? [];
}

export function readActiveArtifactRefFromMetadata(
  metadata: ThreadMessageMetadata | undefined,
): ArtifactRef | null {
  return metadata?.activeArtifactRef ?? null;
}

function hasOnlyMetadataKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalArtifactRefs(
  value: unknown,
): value is ArtifactRef[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every(isArtifactRef))
  );
}

function isOptionalArtifactRef(
  value: unknown,
): value is ArtifactRef | undefined {
  return value === undefined || isArtifactRef(value);
}
