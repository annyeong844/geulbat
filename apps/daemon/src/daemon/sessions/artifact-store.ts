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
  type ProjectId,
  type ThreadArtifactVersion,
  type ThreadId,
  type ThreadMessage,
} from './contract.js';
import { isRecord, tryParseJson } from '../runtime-json.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

interface CommitThreadArtifactVersionArgs {
  workspaceRoot: string;
  projectId: ProjectId;
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
        projectId: args.projectId,
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
    throw new Error(
      `Unsupported thread artifact store schema version: ${String(record.schemaVersion)}`,
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
