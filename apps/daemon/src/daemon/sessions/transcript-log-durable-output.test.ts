import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
} from '../host-command-output-store.js';
import {
  appendTranscriptEntries,
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
  resetTranscriptEntryCacheForTests,
  rewriteTranscriptDurableOutputRefs,
} from './transcript-log.js';

void test('rewriteTranscriptDurableOutputRefs changes only structured result and compaction refs', () => {
  const sourceRef = 'tool-output:00000000-0000-4000-8000-000000000001/run/call';
  const targetRef = 'tool-output:00000000-0000-4000-8000-000000000002/run/call';
  const rewritten = rewriteTranscriptDurableOutputRefs(
    [
      {
        entryId: 'entry-user-ref-text',
        role: 'user',
        content: `do not rewrite this quoted text: ${sourceRef}`,
        timestamp: '2026-07-27T00:00:00.000Z',
      },
      {
        entryId: 'entry-tool-ref',
        role: 'tool_result',
        content: JSON.stringify({
          output: JSON.stringify({
            outputRef: sourceRef,
            snapshot: { outputRef: sourceRef },
          }),
        }),
        timestamp: '2026-07-27T00:00:01.000Z',
      },
      {
        entryId: 'entry-compaction-ref',
        role: 'compaction',
        content: '',
        timestamp: '2026-07-27T00:00:02.000Z',
        compactionData: {
          kind: 'provider_native',
          providerId: 'openai_codex_direct',
          model: 'gpt-fixture',
          output: [{ type: 'compaction_summary', text: 'summary' }],
          tokensBefore: 100,
          contextWindow: 1_000,
          thresholdTokens: 900,
          evidence: [
            {
              callId: 'call',
              toolName: 'search_files',
              outcome: 'success',
              fullOutputBytes: 10,
              outputRef: sourceRef,
            },
          ],
          expandedEvidencePages: [
            { outputRef: sourceRef, offset: 0, endOffset: 10, totalChars: 10 },
          ],
        },
      },
    ],
    new Map([[sourceRef, targetRef]]),
  );

  assert.match(rewritten[0]?.content ?? '', new RegExp(sourceRef));
  assert.doesNotMatch(rewritten[1]?.content ?? '', new RegExp(sourceRef));
  assert.match(rewritten[1]?.content ?? '', new RegExp(targetRef));
  const compaction = rewritten[2];
  assert.equal(compaction?.role, 'compaction');
  if (
    compaction?.role === 'compaction' &&
    'kind' in compaction.compactionData &&
    compaction.compactionData.kind === 'provider_native'
  ) {
    assert.equal(compaction.compactionData.evidence?.[0]?.outputRef, targetRef);
    assert.equal(
      compaction.compactionData.expandedEvidencePages?.[0]?.outputRef,
      targetRef,
    );
  }
});

void test('replaceTranscriptEntries prunes durable outputs whose refs leave the authoritative transcript', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(9);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const retainedOutputRef = buildToolOutputRef({
    threadId,
    runId: 'run-retained',
    callId: 'call-retained',
  });
  const removedOutputRef = buildToolOutputRef({
    threadId,
    runId: 'run-removed',
    callId: 'call-removed',
  });
  const retainedCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000301',
  });
  const removedCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000302',
  });
  const checkpointCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000303',
  });
  for (const [outputRef, runId, callId] of [
    [retainedOutputRef, 'run-retained', 'call-retained'],
    [removedOutputRef, 'run-removed', 'call-removed'],
  ] as const) {
    await writeToolOutputSnapshot({
      stateRoot: workspaceRoot,
      snapshot: buildToolOutputSnapshot({
        outputRef,
        threadId,
        runId,
        callId,
        toolName: 'exec_command',
        output: JSON.stringify({ stdout: `${callId} output` }),
      }),
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId,
        tool: 'exec_command',
        ok: true,
        output: JSON.stringify({
          offloaded: true,
          outputRef,
          recoveryTool: 'read_tool_output',
        }),
      }),
      timestamp: '2026-03-31T00:00:00.000Z',
    });
  }
  const retainedCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: retainedCommandOutputRef,
  });
  const removedCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: removedCommandOutputRef,
  });
  const checkpointCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: checkpointCommandOutputRef,
  });
  for (const paths of [
    retainedCommandPaths,
    removedCommandPaths,
    checkpointCommandPaths,
  ]) {
    await mkdir(paths.directory, { recursive: true });
    await Promise.all([
      writeFile(paths.stdout, 'command output', 'utf8'),
      writeFile(paths.stderr, '', 'utf8'),
    ]);
  }
  await appendTranscriptEntries(workspaceRoot, threadId, [
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-command-retained',
        tool: 'write_stdin',
        ok: true,
        output: JSON.stringify({
          snapshot: { outputRef: retainedCommandOutputRef, status: 'exit' },
          page: null,
        }),
      }),
      timestamp: '2026-03-31T00:00:01.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-command-removed',
        tool: 'exec_command',
        ok: true,
        output: JSON.stringify({
          outputRef: removedCommandOutputRef,
          status: 'exit',
        }),
      }),
      timestamp: '2026-03-31T00:00:02.000Z',
    },
  ]);

  const currentEntries = await readTranscriptEntries(workspaceRoot, threadId);
  await replaceTranscriptEntries(workspaceRoot, threadId, [
    ...currentEntries.filter(
      (entry) =>
        !entry.content.includes(removedOutputRef) &&
        !entry.content.includes(removedCommandOutputRef),
    ),
    {
      role: 'compaction',
      content: '',
      timestamp: '2026-03-31T00:00:03.000Z',
      compactionData: {
        kind: 'provider_native',
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        output: [{ type: 'compaction_summary', encrypted_content: 'opaque' }],
        tokensBefore: 100,
        contextWindow: 1_000,
        thresholdTokens: 900,
        evidence: [
          {
            callId: 'call-command-checkpoint',
            toolName: 'exec_command',
            outcome: 'success',
            fullOutputBytes: 14,
            outputRef: checkpointCommandOutputRef,
          },
        ],
      },
    },
  ]);

  assert.equal(
    (
      await readToolOutputSnapshot({
        stateRoot: workspaceRoot,
        threadId,
        outputRef: retainedOutputRef,
      })
    ).ok,
    true,
  );
  const removed = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: removedOutputRef,
  });
  assert.equal(removed.ok, false);
  if (removed.ok) {
    throw new Error('expected removed snapshot to be pruned');
  }
  assert.equal(removed.errorCode, 'not_found');
  assert.equal(
    (await stat(retainedCommandPaths.directory)).isDirectory(),
    true,
  );
  assert.equal(
    (await stat(checkpointCommandPaths.directory)).isDirectory(),
    true,
  );
  await assert.rejects(
    stat(removedCommandPaths.directory),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
});
