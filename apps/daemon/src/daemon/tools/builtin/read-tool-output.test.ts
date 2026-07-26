import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Digest } from '@geulbat/content-identity/sha256';

import { testThreadId } from '../../../test-support/thread-id.js';
import { testRunId } from '../../../test-support/run-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { createDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../../files/tool-output-store.js';
import { isToolObjectParameters } from '../tool-registry-model.js';
import { readToolOutputTool } from './read-tool-output.js';

void test('read_tool_output provider schema requires an explicit page limit', () => {
  const parameters = readToolOutputTool.parameters;
  assert.equal(isToolObjectParameters(parameters), true);
  if (!isToolObjectParameters(parameters)) {
    assert.fail('expected object tool parameters');
  }
  assert.deepEqual(parameters.required, ['outputRef', 'limit']);
  assert.deepEqual(parameters.properties.mode, {
    type: 'string',
    enum: ['characters', 'items'],
    description:
      'Paging mode. Omit this or use characters for exact character pages. Use items only for list_files entries or search_files results.',
  });
});

void test('read_tool_output catalog distinguishes snapshots from Computer files', () => {
  const metadata = readToolOutputTool.catalogSearchMetadata;
  assert.ok(metadata);
  assert.match(metadata.notFor, /Computer files/u);
  assert.doesNotMatch(metadata.notFor, /workspace/u);
});

void test('read_tool_output rejects raw .geulbat paths instead of treating them as references', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));

  const result = await readToolOutputTool.execute(
    { outputRef: '.geulbat/tool-outputs/thread/run/call.json', limit: 1 },
    {
      callId: 'call-read-tool-output-path',
      stateRoot,
      threadId: testThreadId(81),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /tool-output reference/);
});

void test('read_tool_output rejects blank outputRef at the parser boundary', async () => {
  const result = await readToolOutputTool.execute(
    { outputRef: '   ', limit: 1 },
    {
      callId: 'call-read-tool-output-blank-ref',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /outputRef is required/);
});

void test('read_tool_output rejects output refs from another thread', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(82);
  const otherThreadId = testThreadId(83);

  const result = await readToolOutputTool.execute(
    {
      outputRef: `tool-output:${otherThreadId}/run-search/call-search`,
      limit: 1,
    },
    {
      callId: 'call-read-tool-output-cross-thread',
      stateRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
  assert.match(result.error ?? '', /does not belong to this thread/);
});

void test('read_tool_output returns not_found for a missing snapshot in the current thread', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(86);

  const result = await readToolOutputTool.execute(
    {
      outputRef: `tool-output:${currentThreadId}/run-search/call-search`,
      limit: 1,
    },
    {
      callId: 'call-read-tool-output-missing-snapshot',
      stateRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
  assert.match(result.error ?? '', /not found/);
});

void test('read_tool_output rejects snapshots whose schema identity does not match the ref', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const currentThreadId = testThreadId(84);
  const otherThreadId = testThreadId(85);
  const outputRef = `tool-output:${currentThreadId}/run-search/call-search`;
  const snapshotDir = join(
    stateRoot,
    '.geulbat',
    'tool-outputs',
    currentThreadId,
    'run-search',
  );
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(
    join(snapshotDir, 'call-search.json'),
    JSON.stringify({
      schemaVersion: 2,
      outputRef,
      threadId: otherThreadId,
      runId: 'run-search',
      callId: 'call-search',
      toolName: 'search_files',
      createdAt: '2026-05-14T00:00:00.000Z',
      contentType: 'json',
      fullOutputBytes: 2,
      fullOutputChars: 2,
      output: '{}',
    }) + '\n',
    'utf8',
  );

  const result = await readToolOutputTool.execute(
    { outputRef, limit: 1 },
    {
      callId: 'call-read-tool-output-mismatched-snapshot',
      stateRoot,
      threadId: currentThreadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'internal');
  assert.match(result.error ?? '', /expected schema/);
});

void test('read_tool_output rejects an omitted page limit', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(87);
  const runId = 'run-full-output';
  const callId = 'call-full-output';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const output = 'full-output-line\n'.repeat(2_000);
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'fetch_url',
      output,
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef },
    {
      callId: 'call-read-tool-output-full',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /limit.*required/i);
});

void test('read_tool_output returns an explicit page when limit is provided', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(88);
  const runId = 'run-paged-output';
  const callId = 'call-paged-output';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const output = '0123456789'.repeat(1_000);
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'search_files',
      output,
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, offset: 20, limit: 15 },
    {
      callId: 'call-read-tool-output-page',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, true);
  const page = JSON.parse(result.output) as {
    content?: string;
    endOffset?: number;
    hasMore?: boolean;
    limit?: number | null;
    nextOffset?: number | null;
    offset?: number;
    totalChars?: number;
  };
  assert.equal(page.content, output.slice(20, 35));
  assert.equal(page.offset, 20);
  assert.equal(page.limit, 15);
  assert.equal(page.endOffset, 35);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 35);
  assert.equal(page.totalChars, output.length);
  assert.equal(Object.hasOwn(page, 'truncated'), false);
});

void test('read_tool_output pages an owner-scoped durable failed child result by result ref', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const ownerThreadId = testThreadId(90);
  const otherThreadId = testThreadId(91);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const body = 'failed-child-evidence-'.repeat(20);
  const recorded = store.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId: 'delivery-read-subagent-result',
      parentRunId: testRunId('read-result-parent'),
      childRunId: testRunId('read-result-child'),
      childThreadId: testThreadId(92),
      subagentType: 'worker',
      terminalState: 'failed',
      reason: 'tool_error',
      result: body,
      completedAt: '2026-07-23T13:05:00.000Z',
    },
  }).outcome;
  const daemonContext = createDaemonContext({
    subagentTerminalDeliveries: store,
  });

  try {
    const page = await readToolOutputTool.execute(
      {
        outputRef: recorded.resultRef,
        offset: 7,
        limit: 31,
      },
      {
        callId: 'call-read-subagent-result',
        stateRoot,
        threadId: ownerThreadId,
        runtimeServices: daemonContext,
      },
    );

    assert.equal(page.ok, true);
    assert.deepEqual(JSON.parse(page.output), {
      ok: true,
      outputRef: recorded.resultRef,
      resultDigest: sha256Digest(body),
      sourceType: 'subagent_result',
      childRunId: recorded.result.childRunId,
      terminalState: 'failed',
      reason: 'tool_error',
      offset: 7,
      limit: 31,
      endOffset: 38,
      totalChars: body.length,
      hasMore: true,
      nextOffset: 38,
      content: body.slice(7, 38),
    });

    const foreign = await readToolOutputTool.execute(
      { outputRef: recorded.resultRef, limit: 10 },
      {
        callId: 'call-read-foreign-subagent-result',
        stateRoot,
        threadId: otherThreadId,
        runtimeServices: daemonContext,
      },
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.errorCode, 'access_denied');
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('read_tool_output lets a durable sibling child read a delegated result ref after reopen but rejects an unrelated thread', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const ownerThreadId = testThreadId(93);
  const unrelatedThreadId = testThreadId(94);
  const writer = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const [delegatedReader] = writer.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-delegated-result-reader',
      task: 'read one explicitly delegated sibling result ref',
      subagentType: 'explorer',
      capabilities: ['ptc'],
      parentRunId: testRunId('delegated-result-parent'),
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(delegatedReader);
  const [otherRunReader] = writer.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-other-run-result-reader',
      task: 'must not read a result from another root run',
      subagentType: 'explorer',
      capabilities: ['ptc'],
      parentRunId: testRunId('other-delegated-result-parent'),
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(otherRunReader);
  const recorded = writer.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId: 'delivery-delegated-subagent-result',
      parentRunId: testRunId('delegated-result-parent'),
      childRunId: testRunId('delegated-result-source'),
      childThreadId: testThreadId(95),
      subagentType: 'worker',
      terminalState: 'completed',
      result: 'delegated sibling evidence',
      completedAt: '2026-07-23T14:30:00.000Z',
    },
  }).outcome;
  writer.close();

  const reopened = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentTerminalDeliveries: reopened,
  });

  try {
    const delegated = await readToolOutputTool.execute(
      { outputRef: recorded.resultRef, limit: 9 },
      {
        callId: 'call-read-delegated-subagent-result',
        stateRoot,
        threadId: delegatedReader.childThreadId,
        runtimeServices: daemonContext,
      },
    );
    assert.equal(delegated.ok, true);
    assert.equal(
      JSON.parse(delegated.output).resultDigest,
      sha256Digest(recorded.result.result),
    );
    assert.equal(
      JSON.parse(delegated.output).content,
      recorded.result.result.slice(0, 9),
    );

    const otherRun = await readToolOutputTool.execute(
      { outputRef: recorded.resultRef, limit: 9 },
      {
        callId: 'call-read-other-run-subagent-result',
        stateRoot,
        threadId: otherRunReader.childThreadId,
        runtimeServices: daemonContext,
      },
    );
    assert.equal(otherRun.ok, false);
    assert.equal(otherRun.errorCode, 'access_denied');

    const unrelated = await readToolOutputTool.execute(
      { outputRef: recorded.resultRef, limit: 9 },
      {
        callId: 'call-read-unrelated-subagent-result',
        stateRoot,
        threadId: unrelatedThreadId,
        runtimeServices: daemonContext,
      },
    );
    assert.equal(unrelated.ok, false);
    assert.equal(unrelated.errorCode, 'access_denied');
  } finally {
    reopened.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('read_tool_output returns an exact list_files entry range in item mode', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(89);
  const runId = 'run-list-items';
  const callId = 'call-list-items';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const entries = [
    { path: 'alpha.ts', type: 'file', size: 10 },
    { path: 'beta.ts', type: 'file', size: 20 },
    { path: 'gamma', type: 'directory' },
  ];
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'list_files',
      output: JSON.stringify({
        root: 'computer',
        path: '.',
        total: entries.length,
        entries,
      }),
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, mode: 'items', offset: 1, limit: 1 },
    {
      callId: 'call-read-list-items',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, true);
  const page = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(page['mode'], 'items');
  assert.equal(page['itemField'], 'entries');
  assert.equal(page['offset'], 1);
  assert.equal(page['limit'], 1);
  assert.equal(page['endOffset'], 2);
  assert.equal(page['totalItems'], entries.length);
  assert.equal(page['hasMore'], true);
  assert.equal(page['nextOffset'], 2);
  assert.deepEqual(page['items'], [entries[1]]);
  assert.equal(Object.hasOwn(page, 'content'), false);
  assert.equal(Object.hasOwn(page, 'totalChars'), false);
});

void test('read_tool_output returns an exact search_files result range in item mode', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(90);
  const runId = 'run-search-items';
  const callId = 'call-search-items';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  const results = [
    { path: 'alpha.ts', line: 1, text: 'first' },
    { path: 'beta.ts', line: 2, text: 'second' },
    { path: 'gamma.ts', line: 3, text: 'third' },
  ];
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'search_files',
      output: JSON.stringify({
        root: 'computer',
        path: '.',
        query: 'needle',
        total: results.length,
        results,
      }),
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, mode: 'items', offset: 1, limit: 4 },
    {
      callId: 'call-read-search-items',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, true);
  const page = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(page['itemField'], 'results');
  assert.equal(page['offset'], 1);
  assert.equal(page['endOffset'], 3);
  assert.equal(page['totalItems'], results.length);
  assert.equal(page['hasMore'], false);
  assert.equal(page['nextOffset'], null);
  assert.deepEqual(page['items'], results.slice(1));
});

void test('read_tool_output rejects item mode for unsupported snapshot tools', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(91);
  const runId = 'run-fetch-items';
  const callId = 'call-fetch-items';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'fetch_url',
      output: JSON.stringify({ body: 'not an enumerable result' }),
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, mode: 'items', limit: 1 },
    {
      callId: 'call-read-fetch-items',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /only for list_files and search_files/u);
});

void test('read_tool_output rejects malformed structured snapshots in item mode', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-output-'));
  const threadId = testThreadId(92);
  const runId = 'run-malformed-items';
  const callId = 'call-malformed-items';
  const outputRef = buildToolOutputRef({ threadId, runId, callId });
  await writeToolOutputSnapshot({
    stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef,
      threadId,
      runId,
      callId,
      toolName: 'search_files',
      output: JSON.stringify({ results: 'not-an-array' }),
    }),
  });

  const result = await readToolOutputTool.execute(
    { outputRef, mode: 'items', limit: 1 },
    {
      callId: 'call-read-malformed-items',
      stateRoot,
      threadId,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /valid results array/u);
});
