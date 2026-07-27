import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stableStringify } from '@geulbat/content-identity/stable-json';

import { testRunId } from '../../test-support/run-id.js';
import { createDaemonContext } from '../context.js';
import { isRecord } from '../runtime-json.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
  readPersistedHostCommand,
  writeHostCommandMetadata,
  type HostCommandMetadata,
} from '../host-command-output-store.js';
import { commitThreadArtifactVersion } from './artifact-store.js';
import { assertSessionThreadId } from './contract.js';
import {
  resolveThreadMediaFilePath,
  writeThreadMediaFile,
} from './media-file-store.js';
import {
  readRunAttachment,
  writeRunAttachment,
} from './run-attachment-store.js';
import {
  collectTranscriptDurableOutputRefs,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from './transcript-log.js';
import { createThreadArchiveTransferService } from './thread-portable-transfer.js';
import { loadThreadDetailSnapshot } from './thread-detail.js';
import { loadThreadIndex, upsertThreadSummary } from './threads-index.js';

const SOURCE_THREAD_ID = assertSessionThreadId(
  '00000000-0000-4000-8000-000000009101',
);
const TARGET_THREAD_ID = assertSessionThreadId(
  '00000000-0000-4000-8000-000000009102',
);
const HOST_SESSION_ID = '00000000-0000-4000-8000-000000009103';

void test('portable thread archive round-trips referenced evidence and projection without execution authority', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transfer-source-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'geulbat-transfer-target-'));
  try {
    const sourceContext = createDaemonContext({ homeStateRoot: sourceRoot });
    const targetContext = createDaemonContext({ homeStateRoot: targetRoot });
    const sourceProjection =
      await sourceContext.toolLibraryProjection.resolveProjection({
        stateRoot: sourceRoot,
        threadId: SOURCE_THREAD_ID,
        allowedRegistryNames: [],
      });
    assert.equal(sourceProjection.ok, true);
    if (!sourceProjection.ok) {
      return;
    }
    const projectionIdentity = {
      sdkVersion: sourceProjection.pin.sdkVersion,
      sdkProjectionHash: sourceProjection.pin.sdkProjectionHash,
      policyId: sourceProjection.pin.policyId,
    };

    const attachmentId = '00000000-0000-4000-8000-000000009104';
    const attachmentBytes = Buffer.from('portable attachment');
    await writeRunAttachment({
      workspaceRoot: sourceRoot,
      threadId: SOURCE_THREAD_ID,
      attachmentId,
      bytes: attachmentBytes,
    });

    const mediaBytes = Buffer.from('portable video bytes');
    const media = await writeThreadMediaFile({
      workspaceRoot: sourceRoot,
      threadId: SOURCE_THREAD_ID,
      extension: 'mp4',
      bytes: mediaBytes,
      maxBytes: mediaBytes.byteLength,
    });
    const artifact = await commitThreadArtifactVersion({
      workspaceRoot: sourceRoot,
      threadId: SOURCE_THREAD_ID,
      runId: 'run-portable-artifact',
      renderer: 'video',
      payload: JSON.stringify({
        schemaVersion: 1,
        kind: 'generated_video',
        mimeType: 'video/mp4',
        byteLength: media.byteLength,
        digest: {
          algorithm: 'sha256',
          encoding: 'hex',
          value: media.sha256,
        },
        source: { type: 'thread_media', mediaRef: media.mediaRef },
        provenance: {
          providerId: 'fixture',
          model: 'fixture-video',
          capability: 'video_generation',
          prompt: 'portable video',
          sourceImage: 'blank_canvas',
          generatedAt: '2026-07-27T00:00:00.000Z',
        },
      }),
      digest: media.sha256,
      sourceRef: null,
      timestamp: '2026-07-27T00:00:00.000Z',
    });

    const toolOutputRef = buildToolOutputRef({
      threadId: SOURCE_THREAD_ID,
      runId: 'run-portable-tool',
      callId: 'call-portable-tool',
    });
    await writeToolOutputSnapshot({
      stateRoot: sourceRoot,
      snapshot: buildToolOutputSnapshot({
        outputRef: toolOutputRef,
        threadId: SOURCE_THREAD_ID,
        runId: 'run-portable-tool',
        callId: 'call-portable-tool',
        toolName: 'search_files',
        output: JSON.stringify({ matches: ['portable-result'] }),
      }),
    });

    const hostOutputRef = buildHostCommandOutputRef({
      threadId: SOURCE_THREAD_ID,
      sessionId: HOST_SESSION_ID,
    });
    const hostPaths = buildHostCommandPaths({
      stateRoot: sourceRoot,
      threadId: SOURCE_THREAD_ID,
      outputRef: hostOutputRef,
    });
    const stdout = Buffer.from('portable stdout from offset zero');
    const stderr = Buffer.from('portable stderr from offset zero');
    await mkdir(hostPaths.directory, { recursive: true });
    await Promise.all([
      writeFile(hostPaths.stdout, stdout.subarray(9)),
      writeFile(hostPaths.stderr, stderr.subarray(9)),
      writeFile(hostPaths.stdoutFull, stdout),
      writeFile(hostPaths.stderrFull, stderr),
      writeFile(
        hostPaths.fullOutputState,
        `${JSON.stringify({ schemaVersion: 1, status: 'complete' })}\n`,
      ),
    ]);
    const hostMetadata: HostCommandMetadata = {
      formatVersion: 1,
      schemaVersion: 1,
      sessionId: HOST_SESSION_ID,
      outputRef: hostOutputRef,
      threadId: SOURCE_THREAD_ID,
      runId: 'run-portable-host',
      callId: 'call-portable-host',
      status: 'exit',
      exitCode: 0,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      stdoutChars: stdout.toString('utf8').length,
      stderrChars: stderr.toString('utf8').length,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
      firstOutputAfterMs: 10,
      revision: 1,
      stdinOpen: false,
      outputLimitExceeded: null,
      stdoutBaseOffset: 0,
      stderrBaseOffset: 0,
      fullOutputAvailable: true,
    };
    await writeHostCommandMetadata({
      paths: hostPaths,
      metadata: hostMetadata,
    });

    await replaceTranscriptEntries(sourceRoot, SOURCE_THREAD_ID, [
      {
        entryId: 'entry-portable-user',
        role: 'user',
        content: 'move this conversation',
        timestamp: '2026-07-27T00:00:00.000Z',
        metadata: {
          attachments: [
            {
              attachmentId,
              name: 'portable.txt',
              mimeType: 'text/plain',
              kind: 'text',
              byteLength: attachmentBytes.byteLength,
            },
          ],
        },
      },
      {
        entryId: 'entry-portable-artifact',
        role: 'assistant',
        content: 'video committed',
        timestamp: '2026-07-27T00:00:01.000Z',
        metadata: {
          phase: 'final_answer',
          artifactRefs: [artifact.ref],
          sourceRunId: testRunId('historical-only'),
        },
      },
      {
        entryId: 'entry-portable-tool',
        role: 'tool_result',
        content: JSON.stringify({
          callId: 'call-portable-tool',
          tool: 'search_files',
          ok: true,
          output: JSON.stringify({
            offloaded: true,
            outputRef: toolOutputRef,
            recoveryTool: 'read_tool_output',
          }),
        }),
        timestamp: '2026-07-27T00:00:02.000Z',
      },
      {
        entryId: 'entry-portable-host',
        role: 'tool_result',
        content: JSON.stringify({
          callId: 'call-portable-host',
          tool: 'exec_command',
          ok: true,
          output: JSON.stringify({
            snapshot: { outputRef: hostOutputRef, status: 'exit' },
          }),
        }),
        timestamp: '2026-07-27T00:00:03.000Z',
      },
      {
        entryId: 'entry-portable-compaction',
        role: 'compaction',
        content: '',
        timestamp: '2026-07-27T00:00:04.000Z',
        compactionData: {
          kind: 'provider_native',
          providerId: 'openai_codex_direct',
          model: 'gpt-fixture',
          output: [
            {
              type: 'compaction_summary',
              encrypted_content: 'fixture-encrypted-compaction',
            },
          ],
          tokensBefore: 100,
          contextWindow: 1_000,
          thresholdTokens: 900,
          evidence: [
            {
              callId: 'call-portable-tool',
              toolName: 'search_files',
              outcome: 'success',
              fullOutputBytes: 31,
              outputRef: toolOutputRef,
            },
          ],
          expandedEvidencePages: [
            {
              outputRef: toolOutputRef,
              offset: 0,
              endOffset: 31,
              totalChars: 31,
            },
          ],
        },
      },
    ]);
    await upsertThreadSummary(sourceRoot, {
      threadId: SOURCE_THREAD_ID,
      title: '옮길 대화',
      lastUpdated: '2026-07-27T00:00:04.000Z',
      messageCount: 5,
    });

    const sourceService = createThreadArchiveTransferService({
      stateRoot: sourceRoot,
      projectionTransfer: sourceContext.toolLibraryProjectionTransfer,
      readProjectionIdentity: async () => projectionIdentity,
      now: () => '2026-07-27T00:01:00.000Z',
    });
    const exported = await sourceService.exportArchive({
      threadId: SOURCE_THREAD_ID,
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      return;
    }
    assert.doesNotMatch(
      exported.serializedArchive,
      new RegExp(SOURCE_THREAD_ID),
    );
    assert.doesNotMatch(
      exported.serializedArchive,
      /computerSessionId|permissionMode|"approvals"|"checkpoint"/u,
    );

    const targetService = createThreadArchiveTransferService({
      stateRoot: targetRoot,
      projectionTransfer: targetContext.toolLibraryProjectionTransfer,
      readProjectionIdentity: async () => null,
      now: () => '2026-07-27T00:02:00.000Z',
      createThreadId: () => TARGET_THREAD_ID,
    });
    const incompleteArchive = rewriteCanonicalArchive(
      exported.serializedArchive,
      (archive) => {
        archive.toolOutputs = [];
      },
    );
    assert.deepEqual(
      await targetService.importArchive({
        serializedArchive: incompleteArchive,
      }),
      {
        ok: false,
        code: 'invalid_archive',
        message: 'thread archive tool output references do not match resources',
      },
    );
    const inconsistentHostOutput = rewriteCanonicalArchive(
      exported.serializedArchive,
      (archive) => {
        if (
          !Array.isArray(archive.hostCommands) ||
          !isRecord(archive.hostCommands[0]) ||
          !isRecord(archive.hostCommands[0].metadata) ||
          typeof archive.hostCommands[0].metadata.stdoutBytes !== 'number'
        ) {
          throw new Error('exported host command fixture is malformed');
        }
        archive.hostCommands[0].metadata.stdoutBytes += 1;
      },
    );
    assert.deepEqual(
      await targetService.importArchive({
        serializedArchive: inconsistentHostOutput,
      }),
      {
        ok: false,
        code: 'invalid_archive',
        message: 'portable host command stdout does not match metadata',
      },
    );
    const imported = await targetService.importArchive({
      serializedArchive: exported.serializedArchive,
    });
    assert.deepEqual(imported, {
      ok: true,
      archiveId: exported.archiveId,
      threadId: TARGET_THREAD_ID,
      importedMessageCount: 5,
    });

    const targetTranscript = await readTranscriptEntries(
      targetRoot,
      TARGET_THREAD_ID,
    );
    const targetRefs = collectTranscriptDurableOutputRefs(targetTranscript);
    assert.equal(targetRefs.toolOutputs.size, 1);
    assert.equal(targetRefs.hostCommands.size, 1);
    const [targetToolOutputRef] = targetRefs.toolOutputs;
    const [targetHostOutputRef] = targetRefs.hostCommands;
    assert.match(targetToolOutputRef ?? '', new RegExp(TARGET_THREAD_ID));
    assert.match(targetHostOutputRef ?? '', new RegExp(TARGET_THREAD_ID));
    assert.doesNotMatch(
      JSON.stringify(targetTranscript),
      new RegExp(SOURCE_THREAD_ID),
    );

    const targetToolOutput = await readToolOutputSnapshot({
      stateRoot: targetRoot,
      threadId: TARGET_THREAD_ID,
      outputRef: targetToolOutputRef ?? '',
    });
    assert.equal(targetToolOutput.ok, true);
    if (targetToolOutput.ok) {
      assert.equal(
        targetToolOutput.value.output,
        JSON.stringify({ matches: ['portable-result'] }),
      );
    }
    const targetHostOutput = await readPersistedHostCommand({
      stateRoot: targetRoot,
      threadId: TARGET_THREAD_ID,
      outputRef: targetHostOutputRef ?? '',
    });
    assert.equal(targetHostOutput.ok, true);
    if (targetHostOutput.ok) {
      assert.equal(targetHostOutput.value.metadata.fullOutputAvailable, true);
      assert.equal(
        (await readFile(targetHostOutput.value.paths.stdout)).toString('utf8'),
        'portable stdout from offset zero',
      );
      assert.equal(
        (await readFile(targetHostOutput.value.paths.stderr)).toString('utf8'),
        'portable stderr from offset zero',
      );
      assert.equal(
        (await readFile(targetHostOutput.value.paths.stdoutFull)).toString(
          'utf8',
        ),
        'portable stdout from offset zero',
      );
      assert.equal(
        (await readFile(targetHostOutput.value.paths.stderrFull)).toString(
          'utf8',
        ),
        'portable stderr from offset zero',
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(targetHostOutput.value.paths.fullOutputState, 'utf8'),
        ),
        { schemaVersion: 1, status: 'complete' },
      );
    }

    assert.equal(
      (
        await readRunAttachment({
          workspaceRoot: targetRoot,
          threadId: TARGET_THREAD_ID,
          attachmentId,
        })
      )?.toString('utf8'),
      'portable attachment',
    );
    const detail = await loadThreadDetailSnapshot({
      workspaceRoot: targetRoot,
      threadId: TARGET_THREAD_ID,
    });
    assert.equal(detail.artifacts?.[0]?.artifactId, artifact.ref.artifactId);
    const targetMediaPath = resolveThreadMediaFilePath({
      workspaceRoot: targetRoot,
      threadId: TARGET_THREAD_ID,
      mediaRef: media.mediaRef,
    });
    assert.notEqual(targetMediaPath, null);
    assert.deepEqual(
      targetMediaPath === null ? null : await readFile(targetMediaPath),
      mediaBytes,
    );
    assert.equal(
      (
        await targetContext.toolLibraryProjection.rehydrateProjectionMount({
          stateRoot: targetRoot,
          threadId: TARGET_THREAD_ID,
          expectedIdentity: projectionIdentity,
        })
      ).ok,
      true,
    );
    assert.equal(
      await targetContext.runCheckpoints.readThread(TARGET_THREAD_ID),
      null,
    );
    assert.equal(
      (await loadThreadIndex(targetRoot)).find(
        (entry) => entry.threadId === TARGET_THREAD_ID,
      )?.title,
      '옮길 대화',
    );
    const reexported = await targetService.exportArchive({
      threadId: TARGET_THREAD_ID,
    });
    assert.equal(reexported.ok, true);
    if (reexported.ok) {
      assert.equal(reexported.messageCount, 5);
    }
    assert.equal(
      await targetContext.runCheckpoints.readThread(TARGET_THREAD_ID),
      null,
    );
  } finally {
    await Promise.all([
      rm(sourceRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

void test('portable thread archive rejects tampering and rolls back projection incompatibility', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transfer-tamper-'));
  const targetRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-transfer-rollback-'),
  );
  try {
    const sourceContext = createDaemonContext({ homeStateRoot: sourceRoot });
    const projection =
      await sourceContext.toolLibraryProjection.resolveProjection({
        stateRoot: sourceRoot,
        threadId: SOURCE_THREAD_ID,
        allowedRegistryNames: [],
      });
    assert.equal(projection.ok, true);
    if (!projection.ok) {
      return;
    }
    const identity = {
      sdkVersion: projection.pin.sdkVersion,
      sdkProjectionHash: projection.pin.sdkProjectionHash,
      policyId: projection.pin.policyId,
    };
    await replaceTranscriptEntries(sourceRoot, SOURCE_THREAD_ID, [
      {
        entryId: 'entry-tamper',
        role: 'user',
        content: 'tamper me',
        timestamp: '2026-07-27T00:00:00.000Z',
      },
    ]);
    const sourceService = createThreadArchiveTransferService({
      stateRoot: sourceRoot,
      projectionTransfer: sourceContext.toolLibraryProjectionTransfer,
      readProjectionIdentity: async () => identity,
    });
    const exported = await sourceService.exportArchive({
      threadId: SOURCE_THREAD_ID,
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      return;
    }

    const targetContext = createDaemonContext({ homeStateRoot: targetRoot });
    const targetService = createThreadArchiveTransferService({
      stateRoot: targetRoot,
      projectionTransfer: {
        ...targetContext.toolLibraryProjectionTransfer,
        importProjectionBundle: async () => ({
          ok: false,
          reason: 'projection_failed',
          message: 'destination registry mismatch',
        }),
      },
      readProjectionIdentity: async () => null,
      createThreadId: () => TARGET_THREAD_ID,
    });
    const tampered = exported.serializedArchive.replace(
      'tamper me',
      'tampered text',
    );
    assert.deepEqual(
      await targetService.importArchive({ serializedArchive: tampered }),
      {
        ok: false,
        code: 'invalid_archive',
        message: 'thread archive digest does not match its payload',
      },
    );

    const mismatchedArchive = rewriteCanonicalArchive(
      exported.serializedArchive,
      (archive) => {
        if (
          !isRecord(archive.projection) ||
          !isRecord(archive.projection.identity)
        ) {
          throw new Error('exported projection fixture is malformed');
        }
        archive.projection.identity.policyId = 'mismatched-policy';
      },
    );
    assert.deepEqual(
      await targetService.importArchive({
        serializedArchive: mismatchedArchive,
      }),
      {
        ok: false,
        code: 'invalid_archive',
        message:
          'thread archive projection identity does not match its exact bundle',
      },
    );

    const incompatible = await targetService.importArchive({
      serializedArchive: exported.serializedArchive,
    });
    assert.deepEqual(incompatible, {
      ok: false,
      code: 'projection_incompatible',
      message: 'destination registry mismatch',
    });
    assert.deepEqual(await loadThreadIndex(targetRoot), []);
    assert.deepEqual(
      await readTranscriptEntries(targetRoot, TARGET_THREAD_ID),
      [],
    );
  } finally {
    await Promise.all([
      rm(sourceRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

function rewriteCanonicalArchive(
  serializedArchive: string,
  mutate: (archive: Record<string, unknown>) => void,
): string {
  const archive: unknown = JSON.parse(serializedArchive);
  if (!isRecord(archive)) {
    throw new Error('exported archive fixture is malformed');
  }
  mutate(archive);
  const { archiveId: _archiveId, ...payload } = archive;
  archive.archiveId = `sha256:${createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')}`;
  return `${stableStringify(archive)}\n`;
}

void test('portable thread archive refuses a transcript whose referenced output is missing', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-transfer-missing-'));
  try {
    const context = createDaemonContext({ homeStateRoot: stateRoot });
    const projection = await context.toolLibraryProjection.resolveProjection({
      stateRoot,
      threadId: SOURCE_THREAD_ID,
      allowedRegistryNames: [],
    });
    assert.equal(projection.ok, true);
    if (!projection.ok) {
      return;
    }
    const missingRef = buildToolOutputRef({
      threadId: SOURCE_THREAD_ID,
      runId: 'run-missing',
      callId: 'call-missing',
    });
    await replaceTranscriptEntries(stateRoot, SOURCE_THREAD_ID, [
      {
        entryId: 'entry-missing-output',
        role: 'tool_result',
        content: JSON.stringify({
          callId: 'call-missing',
          tool: 'search_files',
          ok: true,
          output: JSON.stringify({ outputRef: missingRef }),
        }),
        timestamp: '2026-07-27T00:00:00.000Z',
      },
    ]);
    const service = createThreadArchiveTransferService({
      stateRoot,
      projectionTransfer: context.toolLibraryProjectionTransfer,
      readProjectionIdentity: async () => ({
        sdkVersion: projection.pin.sdkVersion,
        sdkProjectionHash: projection.pin.sdkProjectionHash,
        policyId: projection.pin.policyId,
      }),
    });
    const exported = await service.exportArchive({
      threadId: SOURCE_THREAD_ID,
    });
    assert.equal(exported.ok, false);
    if (!exported.ok) {
      assert.equal(exported.code, 'source_incomplete');
      assert.match(exported.message, /referenced tool output is unavailable/u);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
