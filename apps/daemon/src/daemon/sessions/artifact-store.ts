import {
  createSessionArtifactRefKey as createArtifactRefKey,
  isSessionArtifactRecord as isArtifactRecord,
  isSessionArtifactVersionRecord as isArtifactVersionRecord,
  normalizeSessionArtifactSourceRef as normalizeArtifactSourceRef,
  readSessionArtifactRefsFromMetadata as readArtifactRefsFromMetadata,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactRenderer,
  type ArtifactRunId,
  type ArtifactSourceRef,
  type ArtifactVersionRecord,
  type ThreadArtifactVersion,
  type ThreadId,
  type ThreadMessage,
} from './contract.js';
import { parseVideoArtifactPayload } from '@geulbat/protocol/artifacts';

import { isRecord, tryParseJson } from '../runtime-json.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { copyThreadMediaFiles } from './media-file-store.js';
import { artifactStoreFilePath } from './paths.js';
import { hasErrorCode } from '../utils/error.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';

const THREAD_ARTIFACT_STORE_SCHEMA_VERSION = 1;

interface ThreadArtifactStoreFile {
  artifacts: ArtifactRecord[];
  versions: ArtifactVersionRecord[];
}

interface VersionedThreadArtifactStoreFile extends ThreadArtifactStoreFile {
  schemaVersion: typeof THREAD_ARTIFACT_STORE_SCHEMA_VERSION;
}

const EMPTY_STORE: ThreadArtifactStoreFile = {
  artifacts: [],
  versions: [],
};
const runThreadArtifactMutationSerial = createKeyedSerialRunner();

export class ArtifactStoreCorruptionError extends Error {
  readonly code = 'artifact_store_corrupt';
  readonly threadId: string;

  constructor(threadId: string) {
    super(`thread artifact store ${threadId} is corrupted`);
    this.name = 'ArtifactStoreCorruptionError';
    this.threadId = threadId;
  }
}

export interface CommitThreadArtifactVersionArgs {
  workspaceRoot: string;
  threadId: ThreadId;
  runId: ArtifactRunId;
  renderer: ArtifactRenderer;
  payload: string;
  digest: string | null;
  title?: string | null;
  sourceRef: ArtifactSourceRef | null;
  timestamp: string;
}

export async function commitThreadArtifactVersion(
  args: CommitThreadArtifactVersionArgs,
): Promise<{
  artifact: ArtifactRecord;
  version: ArtifactVersionRecord;
  ref: ArtifactRef;
}> {
  return mutateThreadArtifactStore(
    args.workspaceRoot,
    args.threadId,
    async (store) => {
      const artifactId: ArtifactId = `art_${randomUUID()}`;
      const artifact: ArtifactRecord = {
        artifactId,
        threadId: args.threadId,
        renderer: args.renderer,
        title: args.title ?? null,
        sourceRef: args.sourceRef,
        latestVersion: 1,
        persistenceEpoch: 0,
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
      };
      const version: ArtifactVersionRecord = {
        artifactId,
        version: 1,
        parentVersion: null,
        baseVersion: null,
        renderer: args.renderer,
        payload: args.payload,
        digest: args.digest,
        contentHash: createContentHash(args.payload),
        createdAt: args.timestamp,
        createdByRunId: args.runId,
        previewValidation: { ok: true },
      };

      await saveThreadArtifactStore(args.workspaceRoot, args.threadId, {
        artifacts: [...store.artifacts, artifact],
        versions: [...store.versions, version],
      });

      return {
        artifact,
        version,
        ref: { artifactId, version: 1 },
      };
    },
  );
}

export interface CommitThreadArtifactUpdateVersionArgs {
  workspaceRoot: string;
  threadId: ThreadId;
  artifactId: ArtifactId;
  // 낙관적 동시성 소유자 (phase5 commit path spec §5.2) — latestVersion과
  // 불일치하면 version_conflict로 거절되고 스토어는 변하지 않는다.
  baseVersion: number;
  payload: string;
  createdByRunId: ArtifactRunId;
  timestamp: string;
  // 모델 발 update처럼 호출자가 렌더러를 선언하는 경우 — 아티팩트 레벨
  // renderer와 다르면 identity가 갈라지므로 거절한다 (호출자는 새 아티팩트
  // 생성으로 폴백).
  expectedRenderer?: ArtifactRenderer;
}

export type CommitThreadArtifactUpdateVersionResult =
  | {
      ok: true;
      artifact: ArtifactRecord;
      version: ArtifactVersionRecord;
      ref: ArtifactRef;
    }
  | { ok: false; reason: 'artifact_not_found' }
  | { ok: false; reason: 'renderer_mismatch'; renderer: ArtifactRenderer }
  | { ok: false; reason: 'version_conflict'; latestVersion: number };

// 기존 아티팩트에 새 버전을 쌓는 update 경로 — commitThreadArtifactVersion
// (항상 새 artifactId의 v1)과 달리 같은 artifactId의 latestVersion+1을
// append한다. parentVersion은 계보, baseVersion은 낙관적 동시성 소유
// (phase5 canvas/artifact object commit path spec §5.2). 실패 시 실패한
// version row를 남기지 않는다(§5.3).
export async function commitThreadArtifactUpdateVersion(
  args: CommitThreadArtifactUpdateVersionArgs,
): Promise<CommitThreadArtifactUpdateVersionResult> {
  return mutateThreadArtifactStore(
    args.workspaceRoot,
    args.threadId,
    async (store) => {
      const artifact = store.artifacts.find(
        (candidate) => candidate.artifactId === args.artifactId,
      );
      if (!artifact) {
        return { ok: false, reason: 'artifact_not_found' };
      }
      if (
        args.expectedRenderer !== undefined &&
        args.expectedRenderer !== artifact.renderer
      ) {
        return {
          ok: false,
          reason: 'renderer_mismatch',
          renderer: artifact.renderer,
        };
      }
      if (artifact.latestVersion !== args.baseVersion) {
        return {
          ok: false,
          reason: 'version_conflict',
          latestVersion: artifact.latestVersion,
        };
      }

      const nextVersionNumber = artifact.latestVersion + 1;
      const nextArtifact: ArtifactRecord = {
        ...artifact,
        latestVersion: nextVersionNumber,
        updatedAt: args.timestamp,
      };
      const version: ArtifactVersionRecord = {
        artifactId: artifact.artifactId,
        version: nextVersionNumber,
        parentVersion: args.baseVersion,
        baseVersion: args.baseVersion,
        renderer: artifact.renderer,
        payload: args.payload,
        digest: null,
        contentHash: createContentHash(args.payload),
        createdAt: args.timestamp,
        createdByRunId: args.createdByRunId,
        previewValidation: { ok: true },
      };

      await saveThreadArtifactStore(args.workspaceRoot, args.threadId, {
        artifacts: store.artifacts.map((candidate) =>
          candidate.artifactId === artifact.artifactId
            ? nextArtifact
            : candidate,
        ),
        versions: [...store.versions, version],
      });

      return {
        ok: true,
        artifact: nextArtifact,
        version,
        ref: { artifactId: artifact.artifactId, version: nextVersionNumber },
      };
    },
  );
}

// update 커밋 전용 롤백 — 전체 아티팩트 삭제(deleteThreadArtifact)와 달리
// 방금 append된 버전 하나만 걷어내고 latestVersion을 되돌린다. 히스토리가
// 있는 아티팩트를 트랜스크립트 실패 롤백이 통째로 지우면 안 된다.
export async function deleteThreadArtifactUpdateVersion(args: {
  workspaceRoot: string;
  threadId: ThreadId;
  artifactId: ArtifactId;
  version: number;
}): Promise<void> {
  await mutateThreadArtifactStore(
    args.workspaceRoot,
    args.threadId,
    async (store) => {
      const artifact = store.artifacts.find(
        (candidate) => candidate.artifactId === args.artifactId,
      );
      // 걷어낼 버전이 최신이 아니면(그 위로 또 쌓였으면) 히스토리 정합을
      // 지키기 위해 아무것도 하지 않는다 — 롤백 실패는 호출자가 로깅한다.
      if (!artifact || artifact.latestVersion !== args.version) {
        return;
      }
      await saveThreadArtifactStore(args.workspaceRoot, args.threadId, {
        artifacts: store.artifacts.map((candidate) =>
          candidate.artifactId === args.artifactId
            ? { ...candidate, latestVersion: args.version - 1 }
            : candidate,
        ),
        versions: store.versions.filter(
          (candidate) =>
            !(
              candidate.artifactId === args.artifactId &&
              candidate.version === args.version
            ),
        ),
      });
    },
  );
}

export async function deleteThreadArtifact(
  workspaceRoot: string,
  threadId: ThreadId,
  artifactId: ArtifactId,
): Promise<void> {
  await mutateThreadArtifactStore(workspaceRoot, threadId, async (store) => {
    const nextStore: ThreadArtifactStoreFile = {
      artifacts: store.artifacts.filter(
        (artifact) => artifact.artifactId !== artifactId,
      ),
      versions: store.versions.filter(
        (version) => version.artifactId !== artifactId,
      ),
    };
    await saveThreadArtifactStore(workspaceRoot, threadId, nextStore);
  });
}

// 스레드 브랜치용 참조 보존 복사 — commitThreadArtifactVersion과 달리 새
// artifactId를 발급하지 않는다(복사된 메시지 메타데이터의 ref가 그대로
// 유효해야 한다). 대상 스토어는 새 스레드(빈 스토어)라는 전제.
export async function copyThreadArtifactVersionsByRefs(args: {
  workspaceRoot: string;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  refs: readonly ArtifactRef[];
}): Promise<number> {
  if (args.refs.length === 0) {
    return 0;
  }

  const refKeys = new Set(args.refs.map(createArtifactRefKey));
  const source = await loadThreadArtifactStore(
    args.workspaceRoot,
    args.sourceThreadId,
  );
  const copiedVersions = source.versions.filter((version) =>
    refKeys.has(
      createArtifactRefKey({
        artifactId: version.artifactId,
        version: version.version,
      }),
    ),
  );
  if (copiedVersions.length === 0) {
    return 0;
  }

  // media 참조 매니페스트(video 등)는 payload만 복사하면 참조가 깨진다 —
  // 가리키는 파일도 대상 스레드 media 디렉터리로 함께 복사한다(§4.6 수명).
  const mediaRefs = copiedVersions
    .map((version) =>
      version.renderer === 'video'
        ? parseVideoArtifactPayload(version.payload)?.source.mediaRef
        : undefined,
    )
    .filter((mediaRef): mediaRef is string => mediaRef !== undefined);
  await copyThreadMediaFiles({
    workspaceRoot: args.workspaceRoot,
    sourceThreadId: args.sourceThreadId,
    targetThreadId: args.targetThreadId,
    mediaRefs,
  });

  const latestCopiedVersionByArtifact = new Map<ArtifactId, number>();
  for (const version of copiedVersions) {
    const current = latestCopiedVersionByArtifact.get(version.artifactId) ?? 0;
    latestCopiedVersionByArtifact.set(
      version.artifactId,
      Math.max(current, version.version),
    );
  }
  const copiedArtifacts = source.artifacts
    .filter((artifact) =>
      latestCopiedVersionByArtifact.has(artifact.artifactId),
    )
    .map((artifact) => ({
      ...artifact,
      threadId: args.targetThreadId,
      latestVersion:
        latestCopiedVersionByArtifact.get(artifact.artifactId) ??
        artifact.latestVersion,
    }));

  await mutateThreadArtifactStore(
    args.workspaceRoot,
    args.targetThreadId,
    async (store) => {
      await saveThreadArtifactStore(args.workspaceRoot, args.targetThreadId, {
        artifacts: [...store.artifacts, ...copiedArtifacts],
        versions: [...store.versions, ...copiedVersions],
      });
    },
  );
  return copiedVersions.length;
}

export async function loadThreadArtifactVersionsByRefs(
  workspaceRoot: string,
  threadId: string,
  refs: ArtifactRef[],
): Promise<ThreadArtifactVersion[]> {
  if (refs.length === 0) {
    return [];
  }

  const refKeys = new Set(refs.map(createArtifactRefKey));
  const store = await loadThreadArtifactStore(workspaceRoot, threadId);
  return buildThreadArtifactVersions(store, (version) =>
    refKeys.has(
      createArtifactRefKey({
        artifactId: version.artifactId,
        version: version.version,
      }),
    ),
  );
}

export async function loadAllThreadArtifactVersions(
  workspaceRoot: string,
  threadId: string,
): Promise<ThreadArtifactVersion[]> {
  const store = await loadThreadArtifactStore(workspaceRoot, threadId);
  return buildThreadArtifactVersions(store, () => true);
}

function buildThreadArtifactVersions(
  store: ThreadArtifactStoreFile,
  shouldInclude: (version: ArtifactVersionRecord) => boolean,
): ThreadArtifactVersion[] {
  const artifactsById = new Map(
    store.artifacts.map((artifact) => [artifact.artifactId, artifact] as const),
  );

  const versions = new Map<string, ThreadArtifactVersion>();
  for (const version of store.versions) {
    if (!shouldInclude(version)) {
      continue;
    }
    const artifact = artifactsById.get(version.artifactId);
    if (!artifact) {
      continue;
    }
    const threadArtifactVersion: ThreadArtifactVersion = {
      ...version,
      title: artifact.title ?? null,
      persistenceEpoch: artifact.persistenceEpoch,
      sourceRef: artifact.sourceRef ?? null,
    };
    versions.set(
      createArtifactRefKey({
        artifactId: version.artifactId,
        version: version.version,
      }),
      threadArtifactVersion,
    );
  }

  return [...versions.values()].sort(compareThreadArtifactVersions);
}

function compareThreadArtifactVersions(
  left: ThreadArtifactVersion,
  right: ThreadArtifactVersion,
): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  const artifactOrder = left.artifactId.localeCompare(right.artifactId);
  if (artifactOrder !== 0) {
    return artifactOrder;
  }
  return left.version - right.version;
}

export function collectTranscriptArtifactRefs(
  messages: readonly ThreadMessage[],
): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const message of messages) {
    if (!message.metadata) {
      continue;
    }
    refs.push(...readArtifactRefsFromMetadata(message.metadata));
  }
  return refs;
}

async function loadThreadArtifactStore(
  workspaceRoot: string,
  threadId: string,
): Promise<ThreadArtifactStoreFile> {
  const filePath = artifactStoreFilePath(workspaceRoot, threadId);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return EMPTY_STORE;
    }
    throw error;
  }

  const parsed = tryParseJson(raw);
  if (!parsed.ok) {
    throw new ArtifactStoreCorruptionError(threadId);
  }
  return parseThreadArtifactStore(parsed.value);
}

async function saveThreadArtifactStore(
  workspaceRoot: string,
  threadId: string,
  store: ThreadArtifactStoreFile,
): Promise<void> {
  const filePath = artifactStoreFilePath(workspaceRoot, threadId);
  await mkdir(dirname(filePath), { recursive: true });
  const persisted: VersionedThreadArtifactStoreFile = {
    schemaVersion: THREAD_ARTIFACT_STORE_SCHEMA_VERSION,
    ...store,
  };
  await writeTextFileAtomically(
    filePath,
    JSON.stringify(persisted, null, 2) + '\n',
  );
}

async function mutateThreadArtifactStore<T>(
  workspaceRoot: string,
  threadId: string,
  mutate: (store: ThreadArtifactStoreFile) => Promise<T>,
): Promise<T> {
  const filePath = artifactStoreFilePath(workspaceRoot, threadId);
  return runThreadArtifactMutationSerial(filePath, async () => {
    const store = await loadThreadArtifactStore(workspaceRoot, threadId);
    return mutate(store);
  });
}

function parseThreadArtifactStore(value: unknown): ThreadArtifactStoreFile {
  if (!value || typeof value !== 'object') {
    return EMPTY_STORE;
  }
  const record = value as {
    schemaVersion?: unknown;
    artifacts?: unknown;
    versions?: unknown;
  };

  if (
    record.schemaVersion !== undefined &&
    record.schemaVersion !== THREAD_ARTIFACT_STORE_SCHEMA_VERSION
  ) {
    const schemaVersion =
      typeof record.schemaVersion === 'string'
        ? record.schemaVersion
        : JSON.stringify(record.schemaVersion);
    throw new Error(
      `Unsupported thread artifact store schema version: ${schemaVersion ?? 'unknown'}`,
    );
  }

  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .map(normalizePersistedArtifactRecord)
        .filter(isPersistedArtifactRecord)
    : [];
  const versions = Array.isArray(record.versions)
    ? record.versions.filter(isArtifactVersionRecord)
    : [];

  return { artifacts, versions };
}

function normalizePersistedArtifactRecord(
  value: unknown,
): ArtifactRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawSourceRef = value.sourceRef;
  const sourceRef =
    rawSourceRef === null || rawSourceRef === undefined
      ? null
      : normalizeArtifactSourceRef(rawSourceRef);
  if (
    rawSourceRef !== null &&
    rawSourceRef !== undefined &&
    sourceRef === null
  ) {
    return null;
  }

  const candidate = {
    ...value,
    sourceRef,
  };
  return isArtifactRecord(candidate) ? candidate : null;
}

function isPersistedArtifactRecord(
  value: ArtifactRecord | null,
): value is ArtifactRecord {
  return value !== null;
}

export function isArtifactStoreCorruptionError(
  error: unknown,
): error is ArtifactStoreCorruptionError {
  return error instanceof ArtifactStoreCorruptionError;
}

function createContentHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
