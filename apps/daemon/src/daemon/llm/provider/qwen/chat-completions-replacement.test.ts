import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { removeCommandHostWorkspace } from '../../../../test-support/command-host-workspace.js';
import { createDaemonContext } from '../../../context.js';
import { callModelWithDependencies } from '../client.js';
import { resolveProviderRequestOptions } from '../provider-options.js';
import { streamQwenChatCompletions } from './chat-completions-stream.js';
import { summarizeQwenHistory } from './compaction.js';
import { resolveQwenContextCapacityPolicy } from './config.js';

const TEST_API_KEY = 'qwen-test-secret-credential-1234567890';

void test('replacement daemon resumes one command-host-owned Qwen HTTP SSE request without redispatch', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-qwen-replacement-'));
  const provider = await startQwenSseProvider();
  const previousApiKey = process.env.BAILIAN_TOKEN_PLAN_API_KEY;
  const previousBaseUrl = process.env.GEULBAT_QWEN_BASE_URL;
  process.env.BAILIAN_TOKEN_PLAN_API_KEY = TEST_API_KEY;
  process.env.GEULBAT_QWEN_BASE_URL = 'https://example.com/compatible-mode/v1';
  const contexts: ReturnType<typeof createDaemonContext>[] = [];
  t.after(async () => {
    provider.release();
    for (const context of contexts) {
      await context.provider.webSocketSessions.closeAll();
      await context.hostCommands.closeAll();
    }
    await provider.close();
    await removeCommandHostWorkspace(stateRoot);
    await rm(stateRoot, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.BAILIAN_TOKEN_PLAN_API_KEY;
    } else {
      process.env.BAILIAN_TOKEN_PLAN_API_KEY = previousApiKey;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.GEULBAT_QWEN_BASE_URL;
    } else {
      process.env.GEULBAT_QWEN_BASE_URL = previousBaseUrl;
    }
  });

  const first = createQwenRecoveryDaemonContext(stateRoot);
  contexts.push(first);
  const firstAbort = new AbortController();
  const firstIterator = callQwen(first, provider.origin, firstAbort.signal)[
    Symbol.asyncIterator
  ]();
  const firstDelta = await readUntil(firstIterator, 'text_delta');
  assert.equal(firstDelta.text, 'hello ');
  assert.equal(provider.dispatchCount(), 1);

  firstAbort.abort('daemon_shutdown');
  await first.provider.webSocketSessions.closeAll();
  await first.hostCommands.closeAll();
  await firstIterator.return?.(undefined);

  const replacement = createQwenRecoveryDaemonContext(stateRoot);
  contexts.push(replacement);
  const replacementIterator = callQwen(replacement, provider.origin)[
    Symbol.asyncIterator
  ]();
  const replayedDelta = await readUntil(replacementIterator, 'text_delta');
  assert.equal(replayedDelta.text, 'hello ');
  assert.equal(
    provider.dispatchCount(),
    1,
    'replacement must attach to the surviving Qwen request instead of dispatching again',
  );

  provider.release();
  const replacementChunks = await collectRemaining(replacementIterator);
  const replacementDone = replacementChunks.find(
    (chunk) => chunk.type === 'done',
  );
  assert.equal(replacementDone?.finalText, 'hello world');
  assert.equal(provider.dispatchCount(), 1);

  const terminalReplay = await collectRemaining(
    callQwen(replacement, provider.origin)[Symbol.asyncIterator](),
  );
  const terminalDone = terminalReplay.find((chunk) => chunk.type === 'done');
  assert.equal(terminalDone?.finalText, 'hello world');
  assert.equal(provider.dispatchCount(), 1);

  assert.equal(provider.requests().length, 1);
  const request = provider.requests()[0];
  assert.equal(request?.authorization, `Bearer ${TEST_API_KEY}`);
  assert.equal(request?.contentType, 'application/json');
  const body = JSON.parse(request?.body ?? '{}') as {
    model?: unknown;
    stream?: unknown;
    messages?: unknown;
  };
  assert.equal(body.model, 'qwen3.8-max-preview');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(
    JSON.stringify([replacementChunks, terminalReplay]).includes(TEST_API_KEY),
    false,
  );
});

void test('replacement daemon replays one Qwen summary terminal without redispatch', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-qwen-summary-replacement-'),
  );
  const provider = await startQwenSseProvider();
  const contexts: ReturnType<typeof createDaemonContext>[] = [];
  t.after(async () => {
    provider.release();
    for (const context of contexts) {
      await context.provider.webSocketSessions.closeAll();
      await context.hostCommands.closeAll();
    }
    await provider.close();
    await removeCommandHostWorkspace(stateRoot);
    await rm(stateRoot, { recursive: true, force: true });
  });

  const first = createQwenRecoveryDaemonContext(stateRoot);
  contexts.push(first);
  const firstSummaryPromise = callQwenSummary(first, provider.origin);
  provider.release();
  const firstSummary = await firstSummaryPromise;
  assert.equal(firstSummary.summary, 'hello world');
  assert.equal(provider.dispatchCount(), 1);

  await first.provider.webSocketSessions.closeAll();
  await first.hostCommands.closeAll();

  const replacement = createQwenRecoveryDaemonContext(stateRoot);
  contexts.push(replacement);
  const replacementSummary = await callQwenSummary(
    replacement,
    provider.origin,
  );
  assert.deepEqual(replacementSummary, firstSummary);
  assert.equal(
    provider.dispatchCount(),
    1,
    'replacement must replay the durable summary terminal instead of dispatching again',
  );

  const request = provider.requests()[0];
  assert.equal(request?.authorization, `Bearer ${TEST_API_KEY}`);
  const body = JSON.parse(request?.body ?? '{}') as {
    model?: unknown;
    stream?: unknown;
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };
  assert.equal(body.model, 'qwen3.8-max-preview');
  assert.equal(body.stream, true);
  assert.equal(body.messages?.[0]?.role, 'system');
  assert.deepEqual(body.messages?.[1], {
    role: 'user',
    content: 'Preserve this completed work.',
  });
  const summaryRequest = body.messages?.at(-1);
  assert.equal(summaryRequest?.role, 'user');
  assert.equal(typeof summaryRequest?.content, 'string');
  assert.match(String(summaryRequest?.content), /continuation summary/u);
  assert.equal(
    JSON.stringify(replacementSummary).includes(TEST_API_KEY),
    false,
  );
});

function createQwenRecoveryDaemonContext(stateRoot: string) {
  const previousComputerRoot = process.env.GEULBAT_COMPUTER_SESSION_ROOT;
  process.env.GEULBAT_COMPUTER_SESSION_ROOT = stateRoot;
  try {
    return createDaemonContext({
      homeStateRoot: stateRoot,
      hostCommands: { inlineMaxBytes: 256 },
    });
  } finally {
    if (previousComputerRoot === undefined) {
      delete process.env.GEULBAT_COMPUTER_SESSION_ROOT;
    } else {
      process.env.GEULBAT_COMPUTER_SESSION_ROOT = previousComputerRoot;
    }
  }
}

function callQwen(
  context: ReturnType<typeof createDaemonContext>,
  providerOrigin: string,
  signal?: AbortSignal,
) {
  return callModelWithDependencies(
    {
      history: [{ kind: 'user', text: 'hello' }],
      systemPrompt: '',
      providerSessionId: 'qwen-replacement-session',
      providerWebSocketSessions: context.provider.webSocketSessions,
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: resolveProviderRequestOptions({
        GEULBAT_LLM_PROVIDER: 'qwen_token_plan',
      }),
      ...(signal === undefined ? {} : { signal }),
    },
    {
      getProviderAuth: async () =>
        assert.fail('Qwen must not request provider OAuth'),
      forceRefreshProviderAuth: async () =>
        assert.fail('Qwen must not refresh provider OAuth'),
      streamResponsesOverWebSocket: async () =>
        assert.fail('Qwen must not use the Responses WebSocket transport'),
      streamGrokOAuthResponses: async () =>
        assert.fail('Qwen must not use the Grok transport'),
      streamQwenChatCompletions: async (input) =>
        streamQwenChatCompletions({
          ...input,
          config: {
            model: input.config.model,
            baseUrl: `${providerOrigin}/compatible-mode/v1`,
            chatCompletionsUrl: `${providerOrigin}/compatible-mode/v1/chat/completions`,
            apiKey: TEST_API_KEY,
            credentialIdentity: 'qwen-test-credential-identity',
          },
        }),
    },
  );
}

function callQwenSummary(
  context: ReturnType<typeof createDaemonContext>,
  providerOrigin: string,
) {
  return summarizeQwenHistory(
    {
      historyPrefix: [{ kind: 'user', text: 'Preserve this completed work.' }],
      model: 'qwen3.8-max-preview',
      providerSessionId: 'qwen-summary-replacement-session',
      providerRequestSessions: context.provider.webSocketSessions,
    },
    resolveQwenContextCapacityPolicy('qwen3.8-max-preview'),
    {
      loadConfig: async () => ({
        model: 'qwen3.8-max-preview',
        baseUrl: `${providerOrigin}/compatible-mode/v1`,
        chatCompletionsUrl: `${providerOrigin}/compatible-mode/v1/chat/completions`,
        apiKey: TEST_API_KEY,
        credentialIdentity: 'qwen-test-credential-identity',
      }),
      streamChatCompletions: streamQwenChatCompletions,
    },
  );
}

type ModelChunk =
  Awaited<ReturnType<ReturnType<typeof callQwen>['next']>> extends {
    value: infer TValue;
  }
    ? TValue
    : never;

async function readUntil<TType extends ModelChunk['type']>(
  iterator: AsyncIterator<ModelChunk>,
  type: TType,
): Promise<Extract<ModelChunk, { type: TType }>> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      throw new Error(`Qwen stream ended before ${type}`);
    }
    if (next.value.type === 'error') {
      throw new Error(`Qwen stream failed: ${next.value.code}`);
    }
    if (next.value.type === type) {
      return next.value as Extract<ModelChunk, { type: TType }>;
    }
  }
}

async function collectRemaining(
  iterator: AsyncIterator<ModelChunk>,
): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return chunks;
    }
    chunks.push(next.value);
  }
}

interface ObservedRequest {
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

async function startQwenSseProvider(): Promise<{
  origin: string;
  dispatchCount(): number;
  requests(): readonly ObservedRequest[];
  release(): void;
  close(): Promise<void>;
}> {
  let resolveRelease: () => void = () => undefined;
  const release = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const requests: ObservedRequest[] = [];
  const responses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void (async () => {
      responses.add(response);
      response.on('close', () => responses.delete(response));
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push({
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(
        qwenEvent({
          id: 'qwen-replacement-response',
          choices: [{ index: 0, delta: { content: 'hello ' } }],
        }),
      );
      await release;
      response.write(
        qwenEvent({
          id: 'qwen-replacement-response',
          choices: [
            { index: 0, delta: { content: 'world' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
      );
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error
          ? error
          : new Error('Qwen test provider request failed'),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Qwen test provider did not expose a TCP address');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    dispatchCount: () => requests.length,
    requests: () => requests,
    release: () => resolveRelease(),
    async close() {
      resolveRelease();
      for (const response of responses) {
        response.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
}

function qwenEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
