import test from 'node:test';
import assert from 'node:assert/strict';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  type RunStartRequest,
} from '@geulbat/protocol/run-contract';

import { brandThreadId } from '../lib/id-brand-helpers.js';
import { setImageGenerationModelPref } from '../features/assistant/image-model-prefs.js';
import {
  buildApprovalDecisionRequest,
  buildPromptRunRequest,
  buildRunStartRequest,
  cancelRunSession,
  prepareRunStartRequest,
  resolveOptimisticRunPrompt,
  startRunRequestCommand,
  submitApprovalDecision,
} from './run-session-commands.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

function createClientStub() {
  const calls: string[] = [];
  const startRequests: RunStartRequest[] = [];
  const approveRequests: unknown[] = [];
  const cancelRequests: unknown[] = [];

  return {
    calls,
    startRequests,
    approveRequests,
    cancelRequests,
    client: {
      async start(request: RunStartRequest) {
        calls.push('start');
        startRequests.push(request);
        return 'request-start';
      },
      async approve(request: ApprovalRequest) {
        calls.push('approve');
        approveRequests.push(request);
        return 'request-approve';
      },
      async cancel(request: CancelRequest) {
        calls.push('cancel');
        cancelRequests.push(request);
        return 'request-cancel';
      },
      close() {
        calls.push('close');
      },
      async connect() {
        calls.push('connect');
        return undefined;
      },
    },
  };
}

function installRunStartCommandFetch(
  t: test.TestContext,
  fetchImpl: typeof globalThis.fetch,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

void test('buildPromptRunRequest uses the explicit explorer directory', () => {
  assert.deepEqual(
    buildPromptRunRequest({
      prompt: 'hello',
      workingDirectory: 'Users/sample/Downloads',
      modelId: 'gpt-5.6-sol',
      selectedThreadId: THREAD_ID_VALUE,
      permissionMode: 'basic',
      reasoningEffort: 'medium',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    }),
    {
      prompt: 'hello',
      workingDirectory: 'Users/sample/Downloads',
      modelId: 'gpt-5.6-sol',
      threadId: THREAD_ID,
      permissionMode: 'basic',
      reasoningEffort: 'medium',
      subagentModelRouting: { mode: 'auto' },
    },
  );
});

void test('buildPromptRunRequest preserves an explicit empty explorer directory', () => {
  const request = buildPromptRunRequest({
    prompt: 'hello',
    workingDirectory: '',
    modelId: 'gpt-5.6-sol',
    selectedThreadId: null,
    permissionMode: 'basic',
    reasoningEffort: 'medium',
    subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  });

  assert.equal(request.workingDirectory, '');
  assert.equal(Object.hasOwn(request, 'workingDirectory'), true);
});

void test('run request builders carry the saved default image model on every path', () => {
  setImageGenerationModelPref('grok-imagine-image-quality');
  try {
    // 일반 전송/재생성 경로
    const promptRequest = buildPromptRunRequest({
      prompt: 'hello',
      workingDirectory: 'Users/sample/Pictures',
      modelId: 'gpt-5.6-sol',
      selectedThreadId: THREAD_ID_VALUE,
      permissionMode: 'basic',
      reasoningEffort: 'medium',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    });
    assert.equal(
      promptRequest.imageGenerationModel,
      'grok-imagine-image-quality',
    );

    // 아티팩트/브랜치 재실행 경로 — 요청에 이미 명시돼 있으면 그것이 우선
    const startRequest = buildRunStartRequest({
      request: { prompt: 'hello' },
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    });
    assert.equal(
      startRequest.imageGenerationModel,
      'grok-imagine-image-quality',
    );
    const explicit = buildRunStartRequest({
      request: {
        prompt: 'hello',
        imageGenerationModel: 'grok-imagine-image',
      },
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    });
    assert.equal(explicit.imageGenerationModel, 'grok-imagine-image');
  } finally {
    setImageGenerationModelPref(null);
  }

  // 무선택 상태면 필드를 싣지 않는다(데몬 env/내장 기본값 전용, §4.2)
  const withoutPref = buildPromptRunRequest({
    prompt: 'hello',
    workingDirectory: '',
    modelId: 'gpt-5.6-sol',
    selectedThreadId: THREAD_ID_VALUE,
    permissionMode: 'basic',
    reasoningEffort: 'medium',
    subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  });
  assert.equal(withoutPref.imageGenerationModel, undefined);
});

void test('buildRunStartRequest fills the default permission mode only when missing', () => {
  assert.deepEqual(
    buildRunStartRequest({
      request: {
        prompt: 'hello',
      },
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    }),
    {
      prompt: 'hello',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      subagentModelRouting: { mode: 'auto' },
    },
  );

  assert.deepEqual(
    buildRunStartRequest({
      request: {
        prompt: 'hello',
        permissionMode: 'full_access',
      },
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
    }),
    {
      prompt: 'hello',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'full_access',
      subagentModelRouting: { mode: 'auto' },
    },
  );
});

void test('resolveOptimisticRunPrompt prefers displayPrompt, then explicit optimisticPrompt, then raw prompt', () => {
  assert.equal(
    resolveOptimisticRunPrompt({
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
    }),
    'visible prompt',
  );
  assert.equal(
    resolveOptimisticRunPrompt(
      {
        prompt: 'hidden prompt',
      },
      'fallback prompt',
    ),
    'fallback prompt',
  );
  assert.equal(
    resolveOptimisticRunPrompt({
      prompt: 'raw prompt',
    }),
    'raw prompt',
  );
});

void test('prepareRunStartRequest uploads prompt text and returns promptRef metadata', async (t) => {
  const promptText = '<artifact_payload>\n# hello\n</artifact_payload>';
  const seenRequests: Array<{
    input: string | URL | Request;
    init: RequestInit | undefined;
  }> = [];
  installRunStartCommandFetch(t, async (input, init) => {
    seenRequests.push({ input, init });
    return new Response(
      JSON.stringify({
        ok: true,
        promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
        byteLength: Buffer.byteLength(promptText),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  const prepared = await prepareRunStartRequest({
    prompt: promptText,
    displayPrompt: 'Apply artifact to episodes/ch01.md',
    threadId: THREAD_ID,
    workingDirectory: 'episodes',
    currentFile: 'episodes/ch01.md',
    selection: { startLine: 1, endLine: 3, text: '# hello' },
    allowedPublicToolNames: ['read_file', 'write_file', 'apply_patch'],
    permissionMode: 'basic',
    reasoningEffort: 'high',
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
  });

  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0]?.input, '/api/run/prompt-inputs');
  assert.equal(seenRequests[0]?.init?.method, 'POST');
  assert.equal(
    new Headers(seenRequests[0]?.init?.headers).get('content-type'),
    'text/plain;charset=UTF-8',
  );
  assert.equal(seenRequests[0]?.init?.body, promptText);
  assert.equal('prompt' in prepared, false);
  assert.deepEqual(prepared, {
    displayPrompt: 'Apply artifact to episodes/ch01.md',
    threadId: THREAD_ID,
    workingDirectory: 'episodes',
    currentFile: 'episodes/ch01.md',
    selection: { startLine: 1, endLine: 3, text: '# hello' },
    allowedPublicToolNames: ['read_file', 'write_file', 'apply_patch'],
    permissionMode: 'basic',
    reasoningEffort: 'high',
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
    promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
  });
});

void test('startRunRequestCommand dispatches run start and invokes transport', async () => {
  const { client, calls, startRequests } = createClientStub();
  const result = await startRunRequestCommand({
    client,
    prepareStartRequest: async (request) => ({
      ...(request.displayPrompt !== undefined
        ? { displayPrompt: request.displayPrompt }
        : {}),
      ...(request.currentFile !== undefined
        ? { currentFile: request.currentFile }
        : {}),
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    request: {
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
      currentFile: 'docs/a.md',
    },
  });

  assert.deepEqual(result, { kind: 'started', threadId: null });
  assert.deepEqual(calls, ['start']);
  assert.deepEqual(startRequests, [
    {
      displayPrompt: 'visible prompt',
      currentFile: 'docs/a.md',
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    },
  ]);
});

void test('startRunRequestCommand deletes prepared prompt refs when transport start fails', async (t) => {
  const { client } = createClientStub();
  const cleanupRequests: Array<{
    input: string | URL | Request;
    init: RequestInit | undefined;
  }> = [];
  installRunStartCommandFetch(t, async (input, init) => {
    cleanupRequests.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  client.start = async () => {
    throw new Error('start transport down');
  };

  const result = await startRunRequestCommand({
    client,
    prepareStartRequest: async () => ({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    request: {
      prompt: 'hidden prompt',
    },
  });

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'start transport down',
  });
  assert.equal(cleanupRequests.length, 1);
  assert.equal(
    cleanupRequests[0]?.input,
    '/api/run/prompt-inputs?promptRef=run-prompt-input%3A11111111-1111-4111-8111-111111111111',
  );
  assert.equal(cleanupRequests[0]?.init?.method, 'DELETE');
});

void test('startRunRequestCommand deletes uploaded attachment refs when transport start fails', async (t) => {
  const { client } = createClientStub();
  const cleanupRequests: Array<{
    input: string | URL | Request;
    init: RequestInit | undefined;
  }> = [];
  installRunStartCommandFetch(t, async (input, init) => {
    cleanupRequests.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  client.start = async () => {
    throw new Error('start transport down');
  };

  const result = await startRunRequestCommand({
    client,
    prepareStartRequest: async () => ({
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      attachments: [
        {
          name: 'photo.png',
          contentRef: 'file-binary-input:22222222-2222-4222-8222-222222222222',
          mimeType: 'image/png',
        },
      ],
    }),
    request: {
      prompt: 'hidden prompt',
    },
  });

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'start transport down',
  });
  const cleanedUrls = cleanupRequests.map((request) => String(request.input));
  assert.equal(cleanupRequests.length, 2);
  assert.ok(
    cleanedUrls.includes(
      '/api/files/binary-inputs?root=computer&contentRef=file-binary-input%3A22222222-2222-4222-8222-222222222222',
    ),
  );
  assert.ok(
    cleanupRequests.every((request) => request.init?.method === 'DELETE'),
  );
});

void test('startRunRequestCommand returns a failure result when prompt ref preparation fails', async () => {
  const { client, calls } = createClientStub();

  const result = await startRunRequestCommand({
    client,
    prepareStartRequest: async () => {
      throw new Error('prompt upload failed');
    },
    request: {
      prompt: 'hidden prompt',
    },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    kind: 'failed',
    message: 'prompt upload failed',
  });
});

void test('submitApprovalDecision clears approval after sending an allow decision', async () => {
  const { client, calls, approveRequests } = createClientStub();
  const pending = makeApprovalRequiredFixture();

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: true,
    grantScope: 'session',
  });

  assert.deepEqual(calls, ['approve']);
  assert.deepEqual(approveRequests, [
    buildApprovalDecisionRequest({
      pending,
      approved: true,
      grantScope: 'session',
    }),
  ]);
  assert.deepEqual(result, { kind: 'approved' });
});

void test('submitApprovalDecision keeps approval visible after sending a deny decision', async () => {
  const { client, calls, approveRequests } = createClientStub();
  const pending = makeApprovalRequiredFixture();

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: false,
    grantScope: 'once',
  });

  assert.deepEqual(calls, ['approve']);
  assert.deepEqual(approveRequests, [
    buildApprovalDecisionRequest({
      pending,
      approved: false,
      grantScope: 'once',
    }),
  ]);
  assert.deepEqual(result, { kind: 'denied' });
});

void test('submitApprovalDecision keeps approval pending and surfaces an error when approval send fails', async () => {
  const { client } = createClientStub();
  const pending = makeApprovalRequiredFixture({
    permissionMode: 'basic',
  });

  client.approve = async () => {
    throw new Error('approval transport down');
  };

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: true,
    grantScope: 'session',
  });

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'approval transport down',
  });
});

void test('cancelRunSession reconnects the transport when cancelling a pending start', async () => {
  const { client, calls } = createClientStub();
  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'starting',
  });

  assert.deepEqual(calls, ['close', 'connect']);
  assert.deepEqual(result, { kind: 'start_cancelled' });
});

void test('cancelRunSession sends a cancel request for an active run', async () => {
  const { client, calls, cancelRequests } = createClientStub();

  const result = await cancelRunSession({
    client,
    activeRunId: 'run-1',
    phase: 'running',
  });

  assert.deepEqual(calls, ['cancel']);
  assert.equal(cancelRequests.length, 1);
  assert.deepEqual(result, { kind: 'cancel_requested' });
});

void test('cancelRunSession keeps the transport failure visible when reconnect fails during pending start cancel', async () => {
  const { client, calls } = createClientStub();

  client.connect = async () => {
    calls.push('connect_failed');
    throw new Error('socket down');
  };

  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'starting',
  });

  assert.deepEqual(calls, ['close', 'connect_failed']);
  assert.deepEqual(result, {
    kind: 'reconnect_failed',
    message: 'socket down',
  });
});

void test('cancelRunSession does not clear approval when there is nothing to cancel', async () => {
  const { client, calls } = createClientStub();
  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'idle',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { kind: 'noop' });
});
