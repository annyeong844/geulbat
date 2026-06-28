import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FunctionCall } from '../llm/index.js';
import { createRunWorkspaceContext } from '../run-workspace-context.js';
import { readToolOutputSnapshot } from '../files/tool-output-store.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { maybeOffloadToolResult } from './tool-output-offload.js';

void test('maybeOffloadToolResult offloads search_files output without an inline threshold', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(91);
  const output = JSON.stringify({
    query: 'small',
    total: 1,
    results: [{ path: 'src/app.ts', line: 1, text: 'small match' }],
  });

  const result = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-small-search-output'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-small-search-output',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.fullOutputChars, output.length);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult keeps tools outside the offload owner inline', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = 'inline read_file output';

  const result = await maybeOffloadToolResult({
    functionCall: readFileCall('call-read-file-inline'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId: testThreadId(92),
      workspaceRoot,
    }),
    runId: 'run-read-file-inline',
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
});

void test('maybeOffloadToolResult adds a recoverable snapshot ref to exec without removing inline output', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(98);
  const output = JSON.stringify({
    ok: true,
    status: 'running',
    cellId: 'cell-exec-recoverable',
    stdout: 'inline stdout stays visible\n',
    stderr: '',
  });

  const result = await maybeOffloadToolResult({
    functionCall: execCall('call-exec-recoverable-output'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-exec-recoverable-output',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const inlineOutput = JSON.parse(result.output);
  assert.equal(inlineOutput.stdout, 'inline stdout stays visible\n');
  assert.equal(inlineOutput.stderr, '');
  assert.equal(inlineOutput.status, 'running');
  assert.equal(Object.hasOwn(inlineOutput, 'offloaded'), false);
  assert.equal(inlineOutput.fullOutputChars, output.length);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: inlineOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'exec');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult keeps exec output successful when recoverable snapshot recording fails', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(workspaceRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = JSON.stringify({
    ok: true,
    status: 'running',
    cellId: 'cell-exec-inline-on-record-failure',
    stdout: 'stdout still reaches the model\n',
    stderr: '',
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: Awaited<ReturnType<typeof maybeOffloadToolResult>>;
  try {
    result = await maybeOffloadToolResult({
      functionCall: execCall('call-exec-record-failure'),
      runContext: createRunWorkspaceContext({
        projectId: testProjectId(),
        threadId: testThreadId(100),
        workspaceRoot,
      }),
      runId: 'run-exec-record-failure',
      toolResult: { ok: true, output },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(result, { ok: true, output });
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.[0]),
    /failed to record tool output snapshot/,
  );
});

void test('maybeOffloadToolResult adds a recoverable snapshot ref to wait without removing terminal output', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(99);
  const output = JSON.stringify({
    ok: true,
    status: 'completed',
    cellId: 'cell-wait-recoverable',
    exitCode: 0,
    stdout: 'terminal stdout stays visible\n',
    stderr: 'terminal stderr stays visible\n',
  });

  const result = await maybeOffloadToolResult({
    functionCall: waitCall('call-wait-recoverable-output'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-wait-recoverable-output',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const inlineOutput = JSON.parse(result.output);
  assert.equal(inlineOutput.stdout, 'terminal stdout stays visible\n');
  assert.equal(inlineOutput.stderr, 'terminal stderr stays visible\n');
  assert.equal(inlineOutput.status, 'completed');
  assert.equal(Object.hasOwn(inlineOutput, 'offloaded'), false);
  assert.equal(inlineOutput.fullOutputChars, output.length);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: inlineOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'wait');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult keeps memory search inline when output recovery is not available', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = JSON.stringify({
    ok: true,
    total: 1,
    stale: false,
    results: [
      {
        chunkId: 'memory-hit-inline',
        path: 'docs/memory.md',
        title: 'Memory Hit',
        lineStart: 1,
        lineEnd: 2,
        excerpt: 'inline memory excerpt remains reachable',
      },
    ],
  });

  const result = await maybeOffloadToolResult({
    functionCall: searchMemoryIndexCall('call-memory-inline-no-recovery'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId: testThreadId(101),
      workspaceRoot,
    }),
    runId: 'run-memory-inline-no-recovery',
    toolOutputRecoveryAvailable: false,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
  assert.match(result.output, /inline memory excerpt remains reachable/);
});

void test('maybeOffloadToolResult offloads search_files without partial preview text', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(93);
  const output = JSON.stringify({
    query: 'needle',
    total: 2,
    results: [
      {
        path: 'src/app.ts',
        line: 12,
        text: 'const needle = true;',
      },
      'malformed-result',
      {
        path: 123,
        line: 'not-a-line',
        text: 'fallback fields still normalize',
      },
    ],
    padding: 'x'.repeat(5000),
  });

  const result = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-search-without-preview-text'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-search-without-preview-text',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);
  assert.doesNotMatch(result.output, /const needle = true/);
  assert.doesNotMatch(result.output, /fallback fields still normalize/);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult offloads search_memory_index without partial preview text', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(95);
  const output = JSON.stringify({
    ok: true,
    generationId: 'memory-generation',
    indexGeneratedAt: '2026-06-21T00:00:00.000Z',
    sourceIndexVersionToken: 'fresh-token',
    stale: false,
    total: 52,
    truncated: false,
    results: Array.from({ length: 52 }, (_, index) => ({
      chunkId: `memory-hit-${String(index).padStart(2, '0')}`,
      path: `docs/memory-${String(index).padStart(2, '0')}.md`,
      sourceVersionToken: 'source-token',
      title: `Memory Hit ${String(index).padStart(2, '0')}`,
      lineStart: 1,
      lineEnd: 1,
      excerpt: `memory excerpt ${String(index).padStart(2, '0')}`,
    })),
  });

  const result = await maybeOffloadToolResult({
    functionCall: searchMemoryIndexCall('call-memory-index-offload', {
      query: 'memory provenance',
    }),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-memory-index-offload',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'search_memory_index');
  assert.equal(slimOutput.total, 52);
  assert.equal(slimOutput.stale, false);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);
  assert.doesNotMatch(result.output, /memory excerpt 51/);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'search_memory_index');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, { query: 'memory provenance' });
  assert.match(snapshot.value.output, /memory excerpt 51/);
});

void test('maybeOffloadToolResult fails visibly when snapshot write fails', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(workspaceRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = 'output that cannot be snapshotted';
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: Awaited<ReturnType<typeof maybeOffloadToolResult>>;
  try {
    result = await maybeOffloadToolResult({
      functionCall: searchFilesCall('call-write-failure'),
      runContext: createRunWorkspaceContext({
        projectId: testProjectId(),
        threadId: testThreadId(94),
        workspaceRoot,
      }),
      runId: 'run-write-failure',
      toolResult: { ok: true, output },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'internal');
  assert.equal(result.output, '');
  assert.match(result.error, /failed to offload tool output/i);
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.[0]),
    /failed to offload tool output snapshot/,
  );
  assert.deepEqual(warnings[0]?.[1], {
    callId: 'call-write-failure',
    runId: 'run-write-failure',
    threadId: testThreadId(94),
    toolName: 'search_files',
  });
});

void test('maybeOffloadToolResult offloads a large web_fetch result and preserves exact snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(96);
  const output = JSON.stringify({
    ok: true,
    url: 'https://example.com/',
    finalUrl: 'https://example.com/final',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: 'Example',
    content: 'x'.repeat(5000),
    untrusted: true,
  });

  const result = await maybeOffloadToolResult({
    functionCall: webFetchCall('call-web-fetch-offload'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-web-fetch-offload',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'web_fetch');
  assert.equal(slimOutput.finalUrl, 'https://example.com/final');
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'web_fetch');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/final',
  });
});

void test('maybeOffloadToolResult offloads a large list_files result and preserves exact snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(97);
  const output = JSON.stringify({
    path: '.',
    total: 400,
    entries: Array.from({ length: 400 }, (_, index) => ({
      name: `entry-${String(index).padStart(3, '0')}.txt`,
      path: `entry-${String(index).padStart(3, '0')}.txt`,
      type: 'file',
    })),
  });

  const result = await maybeOffloadToolResult({
    functionCall: listFilesCall('call-list-files-offload'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-list-files-offload',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'list_files');
  assert.equal(slimOutput.path, '.');
  assert.equal(slimOutput.total, 400);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'list_files');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, { path: '.' });
});

function listFilesCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'list_files',
    arguments: '{}',
  };
}

function searchFilesCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'search_files',
    arguments: '{}',
  };
}

function searchMemoryIndexCall(
  callId: string,
  args: Record<string, unknown> = {},
): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'search_memory_index',
    arguments: JSON.stringify(args),
  };
}

function execCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'exec',
    arguments: '{}',
  };
}

function readFileCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'read_file',
    arguments: '{}',
  };
}

function waitCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'wait',
    arguments: '{}',
  };
}

function webFetchCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'web_fetch',
    arguments: '{}',
  };
}
