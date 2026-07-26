import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import type { QwenTokenPlanConfig } from './index.js';
import { streamQwenChatCompletions } from './index.js';

const REPLAY_SCOPE = `sha256:${'d'.repeat(64)}` as ProviderReplayScopeId;
const TEST_API_KEY = 'x'.repeat(32);
const CONFIG: QwenTokenPlanConfig = {
  model: 'qwen3.8-max-preview',
  baseUrl:
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  chatCompletionsUrl:
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
  apiKey: TEST_API_KEY,
  credentialIdentity: `sha256:${'e'.repeat(64)}`,
};

void test('Qwen HTTP SSE streams split reasoning, final, tool-call, and usage events', async () => {
  const wire = [
    qwenEvent({
      id: 'response-1',
      choices: [{ index: 0, delta: { reasoning_content: 'Think ' } }],
    }),
    qwenEvent({
      id: 'response-1',
      choices: [
        {
          index: 0,
          delta: {
            content: 'Answer',
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'lookup', arguments: '{"query":' },
              },
            ],
          },
        },
      ],
    }),
    qwenEvent({
      id: 'response-1',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"q"}' } }],
          },
        },
      ],
    }),
    qwenEvent({
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }),
    'data: [DONE]\n\n',
  ].join('');
  const splitAt = [5, 37, 93, 161, wire.length - 4];
  const chunks = splitString(wire, splitAt);
  const deltas: Array<{ phase: string; text: string }> = [];
  const toolDeltas: string[] = [];
  let observedUrl: string | undefined;
  let observedInit: RequestInit | undefined;
  let waitingCount = 0;
  let measuredBytes = 0;

  const result = await streamQwenChatCompletions(
    {
      config: CONFIG,
      history: [{ kind: 'user', text: 'Hello' }],
      providerReplayScopeId: REPLAY_SCOPE,
      instructions: 'Be precise.',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up a value',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      onAssistantDelta: ({ phase, text }) => deltas.push({ phase, text }),
      onFunctionCallArgsDelta: ({ argsDelta }) => toolDeltas.push(argsDelta),
      onRequestPrepared: (measurement) => {
        measuredBytes = measurement.serializedBytes;
        return { kind: 'send' };
      },
      onProviderWaiting: () => {
        waitingCount += 1;
      },
    },
    {
      fetchImpl: (async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return sseResponse(chunks);
      }) as typeof fetch,
    },
  );

  assert.equal(observedUrl, CONFIG.chatCompletionsUrl);
  assert.equal(observedInit?.method, 'POST');
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${TEST_API_KEY}`);
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.equal(headers.get('content-type'), 'application/json');
  const body = JSON.parse(String(observedInit?.body)) as Record<
    string,
    unknown
  >;
  assert.equal(body['model'], 'qwen3.8-max-preview');
  assert.equal(body['stream'], true);
  assert.equal(body['enable_thinking'], true);
  assert.deepEqual(body['stream_options'], { include_usage: true });
  assert.equal(measuredBytes > 0, true);
  assert.equal(waitingCount, 1);
  assert.deepEqual(deltas, [
    { phase: 'commentary', text: 'Think ' },
    { phase: 'final_answer', text: 'Answer' },
  ]);
  assert.deepEqual(toolDeltas, ['{"query":', '"q"}']);
  assert.deepEqual(result.functionCalls, [
    {
      id: 'call-1',
      callId: 'call-1',
      name: 'lookup',
      arguments: '{"query":"q"}',
    },
  ]);
  assert.equal(result.assistantText, 'Think Answer');
  assert.equal(result.finalText, 'Answer');
  assert.deepEqual(result.providerUsageTelemetry, {
    inputTokens: 12,
    outputTokens: 5,
    cachedInputTokens: 3,
  });
  assert.equal(result.itemsToAppend.length, 3);
});

void test('Qwen tool-call streaming tolerates omitted provider index and id after reasoning', async () => {
  const result = await streamQwenChatCompletions(
    {
      config: CONFIG,
      history: [{ kind: 'user', text: 'Hello' }],
      providerReplayScopeId: REPLAY_SCOPE,
    },
    {
      fetchImpl: (async () =>
        sseResponse([
          qwenEvent({
            id: 'response-title',
            choices: [
              { index: 0, delta: { reasoning_content: 'Set title. ' } },
            ],
          }),
          qwenEvent({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      function: {
                        name: 'set_thread_title',
                        arguments: '{"title":"Hello"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          qwenEvent({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      id: '',
                      function: { name: '', arguments: null },
                    },
                  ],
                },
              },
            ],
          }),
          'data: [DONE]\n\n',
        ])) as typeof fetch,
    },
  );

  assert.equal(result.functionCalls.length, 1);
  assert.equal(result.functionCalls[0]?.name, 'set_thread_title');
  assert.equal(result.functionCalls[0]?.arguments, '{"title":"Hello"}');
  assert.match(
    result.functionCalls[0]?.callId ?? '',
    /^qwen-tool-[a-f0-9]{64}$/u,
  );
});

void test('Qwen final-answer streaming accepts nullable optional tool-call fields after reasoning', async () => {
  const result = await streamQwenChatCompletions(
    {
      config: CONFIG,
      history: [{ kind: 'user', text: 'Hello' }],
      providerReplayScopeId: REPLAY_SCOPE,
    },
    {
      fetchImpl: (async () =>
        sseResponse([
          qwenEvent({
            id: 'response-greeting',
            choices: [
              { index: 0, delta: { reasoning_content: 'Respond warmly. ' } },
            ],
          }),
          qwenEvent({
            choices: [
              {
                index: 0,
                delta: { content: '안녕하세요!', tool_calls: null },
              },
            ],
          }),
          'data: [DONE]\n\n',
        ])) as typeof fetch,
    },
  );

  assert.equal(result.finalText, '안녕하세요!');
  assert.equal(result.functionCalls.length, 0);
});

void test('Qwen request preparation stops before the HTTP boundary', async () => {
  let fetchCalled = false;
  await assert.rejects(
    streamQwenChatCompletions(
      {
        config: CONFIG,
        history: [{ kind: 'user', text: 'large context' }],
        providerReplayScopeId: REPLAY_SCOPE,
        onRequestPrepared: () => ({ kind: 'prepare', reason: 'over_window' }),
      },
      {
        fetchImpl: (async () => {
          fetchCalled = true;
          return sseResponse([]);
        }) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { llmCode?: unknown }).llmCode ===
        'llm_context_preparation_required',
  );
  assert.equal(fetchCalled, false);
});

void test('Qwen HTTP errors preserve status for shared retry classification', async () => {
  await assert.rejects(
    streamQwenChatCompletions(
      {
        config: CONFIG,
        history: [{ kind: 'user', text: 'Hello' }],
        providerReplayScopeId: REPLAY_SCOPE,
      },
      {
        fetchImpl: (async () =>
          new Response('', { status: 429 })) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'QwenHttpError' &&
      (error as Error & { status?: unknown }).status === 429,
  );
});

void test('Qwen stream rejects non-SSE, invalid JSON, and empty output', async () => {
  const cases: Array<{ response: Response; message: RegExp }> = [
    {
      response: new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      message: /not an event stream/u,
    },
    {
      response: sseResponse(['data: {invalid}\n\n']),
      message: /invalid JSON/u,
    },
    {
      response: sseResponse([qwenEvent({ choices: [] }), 'data: [DONE]\n\n']),
      message: /completed without output/u,
    },
  ];

  for (const { response, message } of cases) {
    await assert.rejects(
      streamQwenChatCompletions(
        {
          config: CONFIG,
          history: [{ kind: 'user', text: 'Hello' }],
          providerReplayScopeId: REPLAY_SCOPE,
        },
        { fetchImpl: (async () => response) as typeof fetch },
      ),
      message,
    );
  }
});

function qwenEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function splitString(value: string, positions: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  for (const position of positions) {
    chunks.push(value.slice(offset, position));
    offset = position;
  }
  chunks.push(value.slice(offset));
  return chunks;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}
