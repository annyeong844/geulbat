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

void test('maybeOffloadToolResult keeps a 4096 character search_files output inline', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = 'x'.repeat(4096);

  const result = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-threshold-inline'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId: testThreadId(91),
      workspaceRoot,
    }),
    runId: 'run-threshold',
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
});

void test('maybeOffloadToolResult offloads a 4097 character search_files output', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(92);
  const output = 'x'.repeat(4097);

  const result = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-threshold-offload'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId,
      workspaceRoot,
    }),
    runId: 'run-threshold',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.fullOutputChars, 4097);

  const snapshot = await readToolOutputSnapshot({
    workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult emits a stable search_files preview shape', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
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
    functionCall: searchFilesCall('call-preview-shape'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId: testThreadId(93),
      workspaceRoot,
    }),
    runId: 'run-preview-shape',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.deepEqual(slimOutput.preview, [
    {
      path: 'src/app.ts',
      line: 12,
      text: 'const needle = true;',
    },
    {
      path: '',
      line: 0,
      text: 'fallback fields still normalize',
    },
  ]);
});

void test('maybeOffloadToolResult fails visibly when snapshot write fails', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(workspaceRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = 'x'.repeat(4097);

  const result = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-write-failure'),
    runContext: createRunWorkspaceContext({
      projectId: testProjectId(),
      threadId: testThreadId(94),
      workspaceRoot,
    }),
    runId: 'run-write-failure',
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'internal');
  assert.equal(result.output, '');
  assert.match(result.error, /failed to offload large tool output/i);
});

void test('maybeOffloadToolResult offloads a large web_fetch result and preserves exact snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(95);
  const output = JSON.stringify({
    ok: true,
    url: 'https://example.com/',
    finalUrl: 'https://example.com/final',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: 'Example',
    content: 'x'.repeat(5000),
    truncated: false,
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

function searchFilesCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'search_files',
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
