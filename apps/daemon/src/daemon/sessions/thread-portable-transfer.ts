import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { stableStringify } from '@geulbat/content-identity/stable-json';
import {
  isThreadArtifactVersion,
  isThreadMediaRef,
  parseVideoArtifactPayload,
  type ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import type { ThreadMessageAttachment } from '@geulbat/protocol/thread-metadata';
import { isThreadMessage, type ThreadMessage } from '@geulbat/protocol/threads';
import {
  parseToolLibraryProjectionBundle,
  serializeToolLibraryProjectionBundle,
  type ToolLibraryProjectionIdentity,
} from '@geulbat/tool-library/projection-codec';
import { getToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-manifest';

import {
  buildHostCommandPaths,
  readPersistedHostCommand,
  rebindHostCommandMetadataThread,
  writeHostCommandMetadata,
  type HostCommandMetadata,
} from '../host-command-output-store.js';
import { isRecord } from '../runtime-json.js';
import { getErrorMessage } from '../utils/error.js';
import {
  readToolOutputSnapshot,
  rebindToolOutputSnapshotThread,
  writeToolOutputSnapshot,
  type ToolOutputSnapshot,
} from '../files/tool-output-store.js';
import {
  collectTranscriptArtifactRefs,
  loadThreadArtifactVersionsByRefs,
  restoreThreadArtifactVersions,
} from './artifact-store.js';
import { assertSessionThreadId, type ThreadId } from './contract.js';
import { deleteThreadSession } from './delete-thread.js';
import {
  resolveThreadMediaFilePath,
  writeThreadMediaFile,
  type ThreadMediaExtension,
} from './media-file-store.js';
import {
  readRunAttachment,
  writeRunAttachment,
} from './run-attachment-store.js';
import {
  collectTranscriptDurableOutputRefs,
  readTranscriptEntries,
  replaceTranscriptEntries,
  rewriteTranscriptDurableOutputRefs,
} from './transcript-log.js';
import { loadThreadIndex, upsertThreadSummary } from './threads-index.js';

const THREAD_ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_RESOURCE_THREAD_ID = assertSessionThreadId(
  '00000000-0000-4000-8000-000000000000',
);
const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

interface PortableBytes {
  base64: string;
  sha256: `sha256:${string}`;
}

interface PortableAttachment extends PortableBytes {
  attachmentId: string;
  byteLength: number;
}

interface PortableMedia extends PortableBytes {
  mediaRef: string;
}

interface PortableHostCommand {
  metadata: HostCommandMetadata;
  stdout: PortableBytes;
  stderr: PortableBytes;
}

interface PortableProjection {
  bundleId: `sha256:${string}`;
  identity: ToolLibraryProjectionIdentity;
  serializedBundle: string;
}

interface PortableThreadArchivePayload {
  schemaVersion: typeof THREAD_ARCHIVE_SCHEMA_VERSION;
  exportedAt: string;
  title: string;
  transcript: ThreadMessage[];
  attachments: PortableAttachment[];
  artifacts: ThreadArtifactVersion[];
  media: PortableMedia[];
  toolOutputs: ToolOutputSnapshot[];
  hostCommands: PortableHostCommand[];
  projection: PortableProjection;
}

interface PortableThreadArchive extends PortableThreadArchivePayload {
  archiveId: `sha256:${string}`;
}

type ThreadArchiveExportResult =
  | {
      ok: true;
      archiveId: `sha256:${string}`;
      serializedArchive: string;
      messageCount: number;
    }
  | {
      ok: false;
      code: 'not_found' | 'projection_unavailable' | 'source_incomplete';
      message: string;
    };

type ThreadArchiveImportResult =
  | {
      ok: true;
      archiveId: `sha256:${string}`;
      threadId: ThreadId;
      importedMessageCount: number;
    }
  | {
      ok: false;
      code: 'invalid_archive' | 'projection_incompatible' | 'restore_failed';
      message: string;
    };

export interface ThreadArchiveTransferService {
  exportArchive(args: {
    threadId: ThreadId;
  }): Promise<ThreadArchiveExportResult>;
  importArchive(args: {
    serializedArchive: string;
  }): Promise<ThreadArchiveImportResult>;
}

interface ThreadArchiveProjectionTransferPort {
  exportProjectionBundle(args: {
    stateRoot: string;
    threadId: string;
    expectedIdentity?: ToolLibraryProjectionIdentity;
  }): Promise<
    | {
        ok: true;
        bundleId: `sha256:${string}`;
        identity: ToolLibraryProjectionIdentity;
        serializedBundle: string;
      }
    | { ok: false; message: string }
  >;
  importProjectionBundle(args: {
    stateRoot: string;
    threadId: string;
    serializedBundle: string;
  }): Promise<
    | { ok: true; pin: ToolLibraryProjectionIdentity }
    | { ok: false; message: string }
  >;
}

export function createThreadArchiveTransferService(args: {
  stateRoot: string;
  projectionTransfer: ThreadArchiveProjectionTransferPort;
  readProjectionIdentity(
    threadId: ThreadId,
  ): Promise<ToolLibraryProjectionIdentity | null>;
  now?: () => string;
  createThreadId?: () => ThreadId;
}): ThreadArchiveTransferService {
  const now = args.now ?? (() => new Date().toISOString());
  const createThreadId =
    args.createThreadId ?? (() => assertSessionThreadId(randomUUID()));

  return {
    async exportArchive({ threadId }) {
      const transcript = await readTranscriptEntries(args.stateRoot, threadId);
      if (transcript.length === 0) {
        return {
          ok: false,
          code: 'not_found',
          message: `thread has no transcript to export: ${threadId}`,
        };
      }
      const projectionIdentity = await args.readProjectionIdentity(threadId);
      const projection = await args.projectionTransfer.exportProjectionBundle({
        stateRoot: args.stateRoot,
        threadId,
        ...(projectionIdentity === null
          ? {}
          : { expectedIdentity: projectionIdentity }),
      });
      if (!projection.ok) {
        return {
          ok: false,
          code: 'projection_unavailable',
          message: projection.message,
        };
      }

      try {
        const outputResources = await exportDurableOutputResources({
          stateRoot: args.stateRoot,
          threadId,
          transcript,
        });
        const portableTranscript = parseTranscript(
          rewriteTranscriptDurableOutputRefs(
            transcript,
            outputResources.replacements,
          ),
        );
        const attachments = await exportAttachments({
          stateRoot: args.stateRoot,
          threadId,
          transcript: portableTranscript,
        });
        const artifacts = await exportArtifacts({
          stateRoot: args.stateRoot,
          threadId,
          transcript: portableTranscript,
        });
        const media = await exportArtifactMedia({
          stateRoot: args.stateRoot,
          threadId,
          artifacts,
        });
        const title = await readPortableThreadTitle(args.stateRoot, threadId);
        const payload: PortableThreadArchivePayload = {
          schemaVersion: THREAD_ARCHIVE_SCHEMA_VERSION,
          exportedAt: now(),
          title,
          transcript: portableTranscript,
          attachments,
          artifacts,
          media,
          toolOutputs: outputResources.toolOutputs,
          hostCommands: outputResources.hostCommands,
          projection: {
            bundleId: projection.bundleId,
            identity: projection.identity,
            serializedBundle: projection.serializedBundle,
          },
        };
        const archive = createPortableThreadArchive(payload);
        return {
          ok: true,
          archiveId: archive.archiveId,
          serializedArchive: serializePortableThreadArchive(archive),
          messageCount: archive.transcript.length,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'source_incomplete',
          message: getErrorMessage(error),
        };
      }
    },

    async importArchive({ serializedArchive }) {
      let archive: PortableThreadArchive;
      try {
        archive = parsePortableThreadArchive(serializedArchive);
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'invalid_archive',
          message: getErrorMessage(error),
        };
      }

      const threadId = createThreadId();
      try {
        await restoreAttachments({
          stateRoot: args.stateRoot,
          threadId,
          attachments: archive.attachments,
        });
        await restoreMedia({
          stateRoot: args.stateRoot,
          threadId,
          media: archive.media,
        });
        await restoreThreadArtifactVersions({
          workspaceRoot: args.stateRoot,
          threadId,
          versions: archive.artifacts,
        });
        const outputResources = await restoreDurableOutputResources({
          stateRoot: args.stateRoot,
          threadId,
          toolOutputs: archive.toolOutputs,
          hostCommands: archive.hostCommands,
        });
        const transcript = rewriteTranscriptDurableOutputRefs(
          archive.transcript,
          outputResources.replacements,
        );
        await replaceTranscriptEntries(args.stateRoot, threadId, transcript);
        await upsertThreadSummary(args.stateRoot, {
          threadId,
          title: archive.title,
          lastUpdated: now(),
          messageCount: transcript.length,
        });

        const importedProjection =
          await args.projectionTransfer.importProjectionBundle({
            stateRoot: args.stateRoot,
            threadId,
            serializedBundle: archive.projection.serializedBundle,
          });
        if (!importedProjection.ok) {
          const rollbackFailure = await rollbackImportedThread(
            args.stateRoot,
            threadId,
          );
          return {
            ok: false,
            code: 'projection_incompatible',
            message: appendRollbackFailure(
              importedProjection.message,
              rollbackFailure,
            ),
          };
        }
        if (
          importedProjection.pin.sdkVersion !==
            archive.projection.identity.sdkVersion ||
          importedProjection.pin.sdkProjectionHash !==
            archive.projection.identity.sdkProjectionHash ||
          importedProjection.pin.policyId !==
            archive.projection.identity.policyId
        ) {
          const rollbackFailure = await rollbackImportedThread(
            args.stateRoot,
            threadId,
          );
          return {
            ok: false,
            code: 'projection_incompatible',
            message: appendRollbackFailure(
              'imported projection identity does not match the archive',
              rollbackFailure,
            ),
          };
        }

        return {
          ok: true,
          archiveId: archive.archiveId,
          threadId,
          importedMessageCount: transcript.length,
        };
      } catch (error: unknown) {
        const rollbackFailure = await rollbackImportedThread(
          args.stateRoot,
          threadId,
        );
        return {
          ok: false,
          code: 'restore_failed',
          message: appendRollbackFailure(
            getErrorMessage(error),
            rollbackFailure,
          ),
        };
      }
    },
  };
}

async function exportDurableOutputResources(args: {
  stateRoot: string;
  threadId: ThreadId;
  transcript: readonly ThreadMessage[];
}): Promise<{
  replacements: Map<string, string>;
  toolOutputs: ToolOutputSnapshot[];
  hostCommands: PortableHostCommand[];
}> {
  const refs = collectTranscriptDurableOutputRefs(args.transcript);
  const replacements = new Map<string, string>();
  const toolOutputs: ToolOutputSnapshot[] = [];
  for (const outputRef of [...refs.toolOutputs].sort()) {
    const read = await readToolOutputSnapshot({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef,
    });
    if (!read.ok) {
      throw new Error(
        `referenced tool output is unavailable (${read.errorCode}): ${outputRef}`,
      );
    }
    const portable = rebindToolOutputSnapshotThread({
      snapshot: read.value,
      targetThreadId: ARCHIVE_RESOURCE_THREAD_ID,
    });
    replacements.set(outputRef, portable.outputRef);
    toolOutputs.push(portable);
  }

  const hostCommands: PortableHostCommand[] = [];
  for (const outputRef of [...refs.hostCommands].sort()) {
    const read = await readPersistedHostCommand({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef,
    });
    if (!read.ok) {
      throw new Error(
        `referenced host command output is unavailable (${read.reasonCode}): ${outputRef}`,
      );
    }
    const [stdout, stderr] = await Promise.all([
      readFile(
        read.value.metadata.fullOutputAvailable === true
          ? read.value.paths.stdoutFull
          : read.value.paths.stdout,
      ),
      readFile(
        read.value.metadata.fullOutputAvailable === true
          ? read.value.paths.stderrFull
          : read.value.paths.stderr,
      ),
    ]);
    validatePortableHostCommandOutput(read.value.metadata, stdout, stderr);
    const metadata = rebindHostCommandMetadataThread({
      metadata: read.value.metadata,
      targetThreadId: ARCHIVE_RESOURCE_THREAD_ID,
    });
    replacements.set(outputRef, metadata.outputRef);
    hostCommands.push({
      metadata,
      stdout: encodePortableBytes(stdout),
      stderr: encodePortableBytes(stderr),
    });
  }
  return { replacements, toolOutputs, hostCommands };
}

async function restoreDurableOutputResources(args: {
  stateRoot: string;
  threadId: ThreadId;
  toolOutputs: readonly ToolOutputSnapshot[];
  hostCommands: readonly PortableHostCommand[];
}): Promise<{ replacements: Map<string, string> }> {
  const replacements = new Map<string, string>();
  for (const portable of args.toolOutputs) {
    const snapshot = rebindToolOutputSnapshotThread({
      snapshot: portable,
      targetThreadId: args.threadId,
    });
    replacements.set(portable.outputRef, snapshot.outputRef);
    await writeToolOutputSnapshot({ stateRoot: args.stateRoot, snapshot });
  }
  for (const portable of args.hostCommands) {
    const metadata = rebindHostCommandMetadataThread({
      metadata: portable.metadata,
      targetThreadId: args.threadId,
    });
    replacements.set(portable.metadata.outputRef, metadata.outputRef);
    await writePortableHostCommand({
      stateRoot: args.stateRoot,
      metadata,
      stdout: decodePortableBytes(portable.stdout),
      stderr: decodePortableBytes(portable.stderr),
    });
  }
  return { replacements };
}

async function writePortableHostCommand(args: {
  stateRoot: string;
  metadata: HostCommandMetadata;
  stdout: Buffer;
  stderr: Buffer;
}): Promise<void> {
  const paths = buildHostCommandPaths({
    stateRoot: args.stateRoot,
    threadId: args.metadata.threadId,
    outputRef: args.metadata.outputRef,
  });
  await mkdir(paths.directory, { recursive: true });
  try {
    await writeFile(paths.stdout, args.stdout, { flag: 'wx' });
    await writeFile(paths.stderr, args.stderr, { flag: 'wx' });
    if (args.metadata.fullOutputAvailable === true) {
      await writeFile(paths.stdoutFull, args.stdout, { flag: 'wx' });
      await writeFile(paths.stderrFull, args.stderr, { flag: 'wx' });
      await writeFile(
        paths.fullOutputState,
        `${JSON.stringify({ schemaVersion: 1, status: 'complete' })}\n`,
        { flag: 'wx' },
      );
    }
    await writeHostCommandMetadata({ paths, metadata: args.metadata });
    const verified = await readPersistedHostCommand({
      stateRoot: args.stateRoot,
      threadId: args.metadata.threadId,
      outputRef: args.metadata.outputRef,
    });
    if (!verified.ok) {
      throw new Error(verified.message);
    }
  } catch (error: unknown) {
    await rm(paths.directory, { recursive: true, force: true });
    throw error;
  }
}

function validatePortableHostCommandOutput(
  metadata: HostCommandMetadata,
  stdout: Buffer,
  stderr: Buffer,
): void {
  const streams = [
    {
      name: 'stdout',
      bytes: stdout,
      totalBytes: metadata.stdoutBytes,
      baseOffset: metadata.stdoutBaseOffset ?? 0,
      totalChars: metadata.stdoutChars,
    },
    {
      name: 'stderr',
      bytes: stderr,
      totalBytes: metadata.stderrBytes,
      baseOffset: metadata.stderrBaseOffset ?? 0,
      totalChars: metadata.stderrChars,
    },
  ] as const;
  for (const stream of streams) {
    if (
      stream.baseOffset > stream.totalBytes ||
      stream.bytes.byteLength !== stream.totalBytes - stream.baseOffset ||
      (stream.baseOffset === 0 &&
        stream.totalChars !== null &&
        stream.bytes.toString('utf8').length !== stream.totalChars)
    ) {
      throw new Error(
        `portable host command ${stream.name} does not match metadata`,
      );
    }
  }
}

async function exportAttachments(args: {
  stateRoot: string;
  threadId: ThreadId;
  transcript: readonly ThreadMessage[];
}): Promise<PortableAttachment[]> {
  const records = collectTranscriptAttachments(args.transcript);
  const attachments: PortableAttachment[] = [];
  for (const record of [...records.values()].sort((left, right) =>
    left.attachmentId.localeCompare(right.attachmentId),
  )) {
    const bytes = await readRunAttachment({
      workspaceRoot: args.stateRoot,
      threadId: args.threadId,
      attachmentId: record.attachmentId,
    });
    if (bytes === null || bytes.byteLength !== record.byteLength) {
      throw new Error(
        `referenced attachment is unavailable or incomplete: ${record.attachmentId}`,
      );
    }
    attachments.push({
      attachmentId: record.attachmentId,
      byteLength: bytes.byteLength,
      ...encodePortableBytes(bytes),
    });
  }
  return attachments;
}

async function restoreAttachments(args: {
  stateRoot: string;
  threadId: ThreadId;
  attachments: readonly PortableAttachment[];
}): Promise<void> {
  for (const attachment of args.attachments) {
    const bytes = decodePortableBytes(attachment);
    if (bytes.byteLength !== attachment.byteLength) {
      throw new Error(
        `portable attachment byte length mismatch: ${attachment.attachmentId}`,
      );
    }
    await writeRunAttachment({
      workspaceRoot: args.stateRoot,
      threadId: args.threadId,
      attachmentId: attachment.attachmentId,
      bytes,
    });
  }
}

function collectTranscriptAttachments(
  transcript: readonly ThreadMessage[],
): Map<string, ThreadMessageAttachment> {
  const attachments = new Map<string, ThreadMessageAttachment>();
  for (const message of transcript) {
    if (
      message.role !== 'user' ||
      message.metadata === undefined ||
      !('attachments' in message.metadata) ||
      message.metadata.attachments === undefined
    ) {
      continue;
    }
    for (const attachment of message.metadata.attachments) {
      const existing = attachments.get(attachment.attachmentId);
      if (
        existing !== undefined &&
        stableStringify(existing) !== stableStringify(attachment)
      ) {
        throw new Error(
          `attachment metadata conflicts: ${attachment.attachmentId}`,
        );
      }
      attachments.set(attachment.attachmentId, attachment);
    }
  }
  return attachments;
}

async function exportArtifacts(args: {
  stateRoot: string;
  threadId: ThreadId;
  transcript: readonly ThreadMessage[];
}): Promise<ThreadArtifactVersion[]> {
  const refs = collectTranscriptArtifactRefs(args.transcript);
  const uniqueRefKeys = new Set(
    refs.map((ref) => `${ref.artifactId}\u0000${String(ref.version)}`),
  );
  const versions = await loadThreadArtifactVersionsByRefs(
    args.stateRoot,
    args.threadId,
    refs,
  );
  if (versions.length !== uniqueRefKeys.size) {
    throw new Error('one or more referenced artifact versions are unavailable');
  }
  return versions;
}

async function exportArtifactMedia(args: {
  stateRoot: string;
  threadId: ThreadId;
  artifacts: readonly ThreadArtifactVersion[];
}): Promise<PortableMedia[]> {
  const refs = collectArtifactMediaRefs(args.artifacts);

  const media: PortableMedia[] = [];
  for (const mediaRef of [...refs].sort()) {
    const path = resolveThreadMediaFilePath({
      workspaceRoot: args.stateRoot,
      threadId: args.threadId,
      mediaRef,
    });
    if (path === null) {
      throw new Error(`thread media reference is invalid: ${mediaRef}`);
    }
    const bytes = await readFile(path);
    const encoded = encodePortableBytes(bytes);
    if (
      `${encoded.sha256.slice('sha256:'.length)}.${mediaExtension(mediaRef)}` !==
      mediaRef
    ) {
      throw new Error(`thread media digest mismatch: ${mediaRef}`);
    }
    media.push({ mediaRef, ...encoded });
  }
  return media;
}

function collectArtifactMediaRefs(
  artifacts: readonly ThreadArtifactVersion[],
): Set<string> {
  const refs = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.renderer !== 'video') {
      continue;
    }
    const parsed = parseVideoArtifactPayload(artifact.payload);
    if (parsed === null) {
      throw new Error(
        `video artifact payload is invalid: ${artifact.artifactId}@${String(artifact.version)}`,
      );
    }
    refs.add(parsed.source.mediaRef);
  }
  return refs;
}

async function restoreMedia(args: {
  stateRoot: string;
  threadId: ThreadId;
  media: readonly PortableMedia[];
}): Promise<void> {
  for (const item of args.media) {
    const bytes = decodePortableBytes(item);
    const written = await writeThreadMediaFile({
      workspaceRoot: args.stateRoot,
      threadId: args.threadId,
      extension: mediaExtension(item.mediaRef),
      bytes,
      maxBytes: bytes.byteLength,
    });
    if (written.mediaRef !== item.mediaRef) {
      throw new Error(
        `portable thread media digest mismatch: ${item.mediaRef}`,
      );
    }
  }
}

function mediaExtension(mediaRef: string): ThreadMediaExtension {
  if (!isThreadMediaRef(mediaRef)) {
    throw new Error(`invalid thread media ref: ${mediaRef}`);
  }
  const extension = mediaRef.slice(mediaRef.lastIndexOf('.') + 1);
  if (
    extension !== 'mp4' &&
    extension !== 'webm' &&
    extension !== 'png' &&
    extension !== 'jpg' &&
    extension !== 'webp'
  ) {
    throw new Error(`unsupported thread media extension: ${extension}`);
  }
  return extension;
}

async function readPortableThreadTitle(
  stateRoot: string,
  threadId: ThreadId,
): Promise<string> {
  const summary = (await loadThreadIndex(stateRoot)).find(
    (entry) => entry.threadId === threadId,
  );
  const title = summary?.title?.trim();
  return title === undefined || title === '' ? '가져온 대화' : title;
}

function validatePortableThreadArchiveResources(
  payload: PortableThreadArchivePayload,
): void {
  const transcriptAttachments = collectTranscriptAttachments(
    payload.transcript,
  );
  const archiveAttachments = new Map(
    payload.attachments.map((attachment) => [
      attachment.attachmentId,
      attachment,
    ]),
  );
  assertExactArchiveResourceRefs({
    label: 'attachment',
    referenced: transcriptAttachments.keys(),
    archived: archiveAttachments.keys(),
  });
  for (const [attachmentId, metadata] of transcriptAttachments) {
    if (
      archiveAttachments.get(attachmentId)?.byteLength !== metadata.byteLength
    ) {
      throw new Error(
        `thread archive attachment metadata size mismatch: ${attachmentId}`,
      );
    }
  }

  assertExactArchiveResourceRefs({
    label: 'artifact version',
    referenced: collectTranscriptArtifactRefs(payload.transcript).map(
      (ref) => `${ref.artifactId}\u0000${String(ref.version)}`,
    ),
    archived: payload.artifacts.map(
      (artifact) => `${artifact.artifactId}\u0000${String(artifact.version)}`,
    ),
  });
  assertExactArchiveResourceRefs({
    label: 'media',
    referenced: collectArtifactMediaRefs(payload.artifacts),
    archived: payload.media.map((media) => media.mediaRef),
  });

  const durableRefs = collectTranscriptDurableOutputRefs(payload.transcript);
  assertExactArchiveResourceRefs({
    label: 'tool output',
    referenced: durableRefs.toolOutputs,
    archived: payload.toolOutputs.map((snapshot) => snapshot.outputRef),
  });
  assertExactArchiveResourceRefs({
    label: 'host command output',
    referenced: durableRefs.hostCommands,
    archived: payload.hostCommands.map((command) => command.metadata.outputRef),
  });
}

function assertExactArchiveResourceRefs(args: {
  label: string;
  referenced: Iterable<string>;
  archived: Iterable<string>;
}): void {
  const referenced = new Set(args.referenced);
  const archived = new Set(args.archived);
  if (
    referenced.size !== archived.size ||
    [...referenced].some((ref) => !archived.has(ref))
  ) {
    throw new Error(
      `thread archive ${args.label} references do not match resources`,
    );
  }
}

function createPortableThreadArchive(
  payload: PortableThreadArchivePayload,
): PortableThreadArchive {
  validatePortableThreadArchiveResources(payload);
  return {
    archiveId: digestText(stableStringify(payload)),
    ...payload,
  };
}

function serializePortableThreadArchive(
  archive: PortableThreadArchive,
): string {
  return `${stableStringify(archive)}\n`;
}

function parsePortableThreadArchive(
  serializedArchive: string,
): PortableThreadArchive {
  let value: unknown;
  try {
    value = JSON.parse(serializedArchive);
  } catch {
    throw new Error('thread archive is not valid JSON');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'archiveId',
      'artifacts',
      'attachments',
      'exportedAt',
      'hostCommands',
      'media',
      'projection',
      'schemaVersion',
      'title',
      'toolOutputs',
      'transcript',
    ]) ||
    value.schemaVersion !== THREAD_ARCHIVE_SCHEMA_VERSION ||
    !isSha256Id(value.archiveId) ||
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.title !== 'string'
  ) {
    throw new Error('thread archive header is invalid');
  }

  const transcript = parseTranscript(value.transcript);
  const attachments = parseAttachments(value.attachments);
  const artifacts = parseArtifacts(value.artifacts);
  const media = parseMedia(value.media);
  const toolOutputs = parseToolOutputs(value.toolOutputs);
  const hostCommands = parseHostCommands(value.hostCommands);
  const projection = parseProjection(value.projection);
  const payload: PortableThreadArchivePayload = {
    schemaVersion: THREAD_ARCHIVE_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    title: value.title,
    transcript,
    attachments,
    artifacts,
    media,
    toolOutputs,
    hostCommands,
    projection,
  };
  const archive = createPortableThreadArchive(payload);
  if (archive.archiveId !== value.archiveId) {
    throw new Error('thread archive digest does not match its payload');
  }
  if (serializedArchive !== serializePortableThreadArchive(archive)) {
    throw new Error('thread archive is not canonical');
  }
  return archive;
}

function parseTranscript(value: unknown): ThreadMessage[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive transcript is invalid');
  }
  const transcript: ThreadMessage[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isThreadMessage(entry)) {
      throw new Error(`thread archive transcript entry ${index} is invalid`);
    }
    transcript.push(entry);
  }
  return transcript;
}

function parseAttachments(value: unknown): PortableAttachment[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive attachments are invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['attachmentId', 'base64', 'byteLength', 'sha256']) ||
      typeof item.attachmentId !== 'string' ||
      item.attachmentId === '' ||
      typeof item.byteLength !== 'number' ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 0
    ) {
      throw new Error('thread archive attachment entry is invalid');
    }
    if (seen.has(item.attachmentId)) {
      throw new Error(
        `duplicate thread archive attachment: ${item.attachmentId}`,
      );
    }
    seen.add(item.attachmentId);
    const bytes = parsePortableBytes(item);
    if (bytes.bytes.byteLength !== item.byteLength) {
      throw new Error(
        `thread archive attachment size mismatch: ${item.attachmentId}`,
      );
    }
    return {
      attachmentId: item.attachmentId,
      byteLength: item.byteLength,
      base64: bytes.portable.base64,
      sha256: bytes.portable.sha256,
    };
  });
}

function parseArtifacts(value: unknown): ThreadArtifactVersion[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive artifacts are invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isThreadArtifactVersion(item)) {
      throw new Error('thread archive artifact version is invalid');
    }
    const key = `${item.artifactId}\u0000${String(item.version)}`;
    if (seen.has(key)) {
      throw new Error(`duplicate thread archive artifact version: ${key}`);
    }
    seen.add(key);
    return normalizeThreadArtifactVersion(item);
  });
}

function normalizeThreadArtifactVersion(
  value: ThreadArtifactVersion,
): ThreadArtifactVersion {
  return {
    artifactId: value.artifactId,
    version: value.version,
    parentVersion: value.parentVersion,
    baseVersion: value.baseVersion,
    renderer: value.renderer,
    payload: value.payload,
    digest: value.digest,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
    createdByRunId: value.createdByRunId,
    previewValidation: value.previewValidation,
    ...(value.planStamp === undefined ? {} : { planStamp: value.planStamp }),
    title: value.title,
    persistenceEpoch: value.persistenceEpoch,
    sourceRef: value.sourceRef,
  };
}

function parseMedia(value: unknown): PortableMedia[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive media is invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['base64', 'mediaRef', 'sha256']) ||
      !isThreadMediaRef(item.mediaRef)
    ) {
      throw new Error('thread archive media entry is invalid');
    }
    if (seen.has(item.mediaRef)) {
      throw new Error(`duplicate thread archive media: ${item.mediaRef}`);
    }
    seen.add(item.mediaRef);
    const bytes = parsePortableBytes(item);
    if (
      `${bytes.portable.sha256.slice('sha256:'.length)}.${mediaExtension(item.mediaRef)}` !==
      item.mediaRef
    ) {
      throw new Error(`thread archive media digest mismatch: ${item.mediaRef}`);
    }
    return { mediaRef: item.mediaRef, ...bytes.portable };
  });
}

function parseToolOutputs(value: unknown): ToolOutputSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive tool outputs are invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const normalized = rebindToolOutputSnapshotThread({
      snapshot: item,
      targetThreadId: ARCHIVE_RESOURCE_THREAD_ID,
    });
    if (stableStringify(normalized) !== stableStringify(item)) {
      throw new Error('thread archive tool output is not canonical');
    }
    if (seen.has(normalized.outputRef)) {
      throw new Error(
        `duplicate thread archive tool output: ${normalized.outputRef}`,
      );
    }
    seen.add(normalized.outputRef);
    return normalized;
  });
}

function parseHostCommands(value: unknown): PortableHostCommand[] {
  if (!Array.isArray(value)) {
    throw new Error('thread archive host commands are invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['metadata', 'stderr', 'stdout'])
    ) {
      throw new Error('thread archive host command entry is invalid');
    }
    const metadata = rebindHostCommandMetadataThread({
      metadata: item.metadata,
      targetThreadId: ARCHIVE_RESOURCE_THREAD_ID,
    });
    if (stableStringify(metadata) !== stableStringify(item.metadata)) {
      throw new Error('thread archive host command metadata is not canonical');
    }
    if (seen.has(metadata.outputRef)) {
      throw new Error(
        `duplicate thread archive host command: ${metadata.outputRef}`,
      );
    }
    seen.add(metadata.outputRef);
    const stdout = parsePortableBytes(item.stdout);
    const stderr = parsePortableBytes(item.stderr);
    validatePortableHostCommandOutput(metadata, stdout.bytes, stderr.bytes);
    return {
      metadata,
      stdout: stdout.portable,
      stderr: stderr.portable,
    };
  });
}

function parseProjection(value: unknown): PortableProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['bundleId', 'identity', 'serializedBundle']) ||
    !isSha256Id(value.bundleId) ||
    typeof value.serializedBundle !== 'string' ||
    !isRecord(value.identity) ||
    !hasExactKeys(value.identity, [
      'policyId',
      'sdkProjectionHash',
      'sdkVersion',
    ]) ||
    typeof value.identity.sdkVersion !== 'string' ||
    !isSha256Id(value.identity.sdkProjectionHash) ||
    typeof value.identity.policyId !== 'string'
  ) {
    throw new Error('thread archive projection is invalid');
  }
  let bundle: ReturnType<typeof parseToolLibraryProjectionBundle>;
  try {
    bundle = parseToolLibraryProjectionBundle(value.serializedBundle);
  } catch {
    throw new Error('thread archive projection bundle is invalid');
  }
  const bundleIdentity = getToolLibraryProjectionIdentity(bundle.manifest);
  if (
    bundle.bundleId !== value.bundleId ||
    serializeToolLibraryProjectionBundle(bundle) !== value.serializedBundle ||
    bundleIdentity.sdkVersion !== value.identity.sdkVersion ||
    bundleIdentity.sdkProjectionHash !== value.identity.sdkProjectionHash ||
    bundleIdentity.policyId !== value.identity.policyId
  ) {
    throw new Error(
      'thread archive projection identity does not match its exact bundle',
    );
  }
  return {
    bundleId: value.bundleId,
    identity: {
      sdkVersion: value.identity.sdkVersion,
      sdkProjectionHash: value.identity.sdkProjectionHash,
      policyId: value.identity.policyId,
    },
    serializedBundle: value.serializedBundle,
  };
}

function encodePortableBytes(bytes: Uint8Array): PortableBytes {
  const buffer = Buffer.from(bytes);
  return {
    base64: buffer.toString('base64'),
    sha256: digestBytes(buffer),
  };
}

function decodePortableBytes(portable: PortableBytes): Buffer {
  return parsePortableBytes(portable).bytes;
}

function parsePortableBytes(value: unknown): {
  bytes: Buffer;
  portable: PortableBytes;
} {
  if (
    !isRecord(value) ||
    typeof value.base64 !== 'string' ||
    !isSha256Id(value.sha256)
  ) {
    throw new Error('portable byte record is invalid');
  }
  const bytes = Buffer.from(value.base64, 'base64');
  if (
    bytes.toString('base64') !== value.base64 ||
    digestBytes(bytes) !== value.sha256
  ) {
    throw new Error('portable byte record digest does not match');
  }
  return {
    bytes,
    portable: { base64: value.base64, sha256: value.sha256 },
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isSha256Id(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_ID_PATTERN.test(value);
}

async function rollbackImportedThread(
  stateRoot: string,
  threadId: ThreadId,
): Promise<string | null> {
  try {
    await deleteThreadSession(stateRoot, threadId);
    return null;
  } catch (error: unknown) {
    return getErrorMessage(error);
  }
}

function appendRollbackFailure(
  message: string,
  rollbackFailure: string | null,
): string {
  return rollbackFailure === null
    ? message
    : `${message}; import rollback also failed: ${rollbackFailure}`;
}
