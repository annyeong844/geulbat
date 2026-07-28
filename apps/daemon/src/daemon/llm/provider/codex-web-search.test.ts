import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

import { createDaemonHostCommandRuntime } from '../../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  buildHostCommandPaths,
  SYSTEM_SESSION_OWNER,
} from '../../host-command-output-store.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from '../../host-routed-detached-process.js';
import { createResponsesWebSocketSessionStore } from './transport/responses-websocket-cache.js';
import { createHostRoutedResponsesRequestTransport } from './transport/responses-durable-request.js';
import { streamResponsesOverWebSocket } from './transport/responses-websocket.js';
import {
  createCodexWebSearchRuntime,
  searchCodexWeb,
} from './codex-web-search.js';

function createSearchResponse(args: {
  answer: string;
  annotations?: Record<string, unknown>[];
}) {
  return {
    itemsToAppend: [
      {
        kind: 'backend_item' as const,
        data: {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: args.answer,
              annotations: args.annotations ?? [],
            },
          ],
        },
      },
    ],
    functionCalls: [],
    assistantText: args.answer,
    finalText: args.answer,
  };
}

void test('Codex native web search reuses OAuth headers, model, session, and hosted web_search', async () => {
  let normalizedMessage: Record<string, unknown> | undefined;
  const result = await searchCodexWeb({
    query: 'current TypeScript handbook',
    model: 'gpt-5.6-sol',
    providerSessionId: 'run-search-1',
    runtime: {
      authRuntime: createProviderAuthRuntimeStore(),
      webSocketSessions: createResponsesWebSocketSessionStore(),
      dependencies: {
        getAuth: async () => ({
          accessToken: 'oauth-secret',
          accountId: 'account-1',
        }),
        streamResponses: async (input) => {
          assert.equal(
            input.headers.get('authorization'),
            'Bearer oauth-secret',
          );
          assert.equal(input.headers.get('chatgpt-account-id'), 'account-1');
          assert.equal(input.headers.get('session_id'), 'run-search-1');
          assert.deepEqual(input.payload, {
            type: 'response.create',
            model: 'gpt-5.6-sol',
            store: false,
            stream: true,
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'current TypeScript handbook',
                  },
                ],
              },
            ],
            tools: [{ type: 'web_search', search_context_size: 'high' }],
            tool_choice: { type: 'web_search' },
          });
          normalizedMessage = input.normalizeEvent?.({
            type: 'response.output_item.added',
            item: { id: 'message-1', type: 'message' },
          });
          return createSearchResponse({
            answer: 'The current handbook is cited.',
            annotations: [
              {
                type: 'url_citation',
                title: 'TypeScript Handbook',
                url: 'https://www.typescriptlang.org/docs/handbook/',
              },
            ],
          });
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('expected native Codex search success');
  }
  assert.equal(result.answer, 'The current handbook is cited.');
  assert.deepEqual(result.results, [
    {
      title: 'TypeScript Handbook',
      url: 'https://www.typescriptlang.org/docs/handbook/',
      snippet: '',
    },
  ]);
  assert.deepEqual(normalizedMessage, {
    type: 'response.output_item.added',
    item: {
      id: 'message-1',
      type: 'message',
      phase: 'final_answer',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /oauth-secret|account-1/u);
});

void test('Codex native web search retries one auth failure through the existing refresh owner', async () => {
  let streamCount = 0;
  let refreshCount = 0;
  const requestAttempts: number[] = [];
  const runtime = createCodexWebSearchRuntime({
    authRuntime: createProviderAuthRuntimeStore(),
    webSocketSessions: createResponsesWebSocketSessionStore(),
    dependencies: {
      getAuth: async () => ({
        accessToken: streamCount === 0 ? 'expired' : 'refreshed',
        accountId: 'account-1',
      }),
      forceRefreshAuth: async () => {
        refreshCount += 1;
        return {
          accessToken: 'refreshed',
          accountId: 'account-1',
        };
      },
      streamResponses: async (input) => {
        requestAttempts.push(input.requestAttempt ?? -1);
        streamCount += 1;
        if (streamCount === 1) {
          throw Object.assign(new Error('expired'), {
            llmCode: 'llm_auth_failed',
          });
        }
        return createSearchResponse({
          answer: 'Search completed after refresh.',
        });
      },
    },
  });

  const result = await runtime.search({
    query: 'current release',
    model: 'gpt-5.6-sol',
    providerSessionId: 'run-search-refresh',
  });

  assert.equal(result.ok, true);
  assert.equal(streamCount, 2);
  assert.equal(refreshCount, 1);
  assert.deepEqual(requestAttempts, [0, 1]);
});

void test('Codex native web search returns a sanitized auth failure after refresh cannot recover', async () => {
  const originalWarn = console.warn;
  const warns: unknown[][] = [];
  const refreshError = Object.assign(new Error('sensitive refresh detail'), {
    llmCode: 'llm_auth_failed',
  });
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };

  try {
    const result = await searchCodexWeb({
      query: 'current release',
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-search-auth-failure',
      runtime: {
        authRuntime: createProviderAuthRuntimeStore(),
        webSocketSessions: createResponsesWebSocketSessionStore(),
        dependencies: {
          getAuth: async () => {
            throw Object.assign(new Error('sensitive missing session detail'), {
              llmCode: 'llm_auth_failed',
            });
          },
          forceRefreshAuth: async () => {
            throw refreshError;
          },
        },
      },
    });

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'provider_unauthorized',
      message: 'provider authentication failed',
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /sensitive missing session detail|sensitive refresh detail/u,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warns.length, 1);
  assert.match(
    String(warns[0]?.[0] ?? ''),
    /warn \[llm\/provider\/codex-web-search\] Codex native web search failed/u,
  );
  assert.equal(
    (warns[0]?.[1] as { reasonCode?: unknown })?.reasonCode,
    'provider_unauthorized',
  );
  assert.equal((warns[0]?.[1] as { cause?: unknown })?.cause, refreshError);
});

void test('Codex native web search rejects an empty provider result visibly', async () => {
  const result = await searchCodexWeb({
    query: 'current release',
    model: 'gpt-5.6-sol',
    providerSessionId: 'run-search-empty',
    runtime: {
      authRuntime: createProviderAuthRuntimeStore(),
      webSocketSessions: createResponsesWebSocketSessionStore(),
      dependencies: {
        getAuth: async () => ({
          accessToken: 'oauth-secret',
          accountId: 'account-1',
        }),
        streamResponses: async () => createSearchResponse({ answer: '' }),
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'invalid_response',
    message:
      'Codex native web search returned no readable answer or source URLs.',
  });
});

void test('Codex native web search stops before auth when the caller is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let authCalled = false;
  const result = await searchCodexWeb({
    query: 'current release',
    model: 'gpt-5.6-sol',
    providerSessionId: 'run-search-aborted',
    signal: controller.signal,
    runtime: {
      authRuntime: createProviderAuthRuntimeStore(),
      webSocketSessions: createResponsesWebSocketSessionStore(),
      dependencies: {
        getAuth: async () => {
          authCalled = true;
          return {
            accessToken: 'oauth-secret',
            accountId: 'account-1',
          };
        },
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'aborted',
    message: 'web_search was aborted.',
  });
  assert.equal(authCalled, false);
});

interface NativeSearchProviderBoundary {
  stateRoot: string;
  webSocketUrl: string;
  firstDispatch: Promise<void>;
  createRuntime(): NativeSearchWorkerRuntime;
  closeRuntime(runtime: NativeSearchWorkerRuntime): Promise<void>;
  dispatchCount(): number;
  observedAuthorization(): string | undefined;
  requestPayloads(): Record<string, unknown>[];
  releaseProvider(): void;
}

interface NodeModuleCommand {
  execPath: string;
  args: string[];
}

type NativeSearchWorkerRuntime = ReturnType<
  typeof createNativeSearchWorkerRuntime
>;

void test(
  'Codex native web search survives daemon replacement on one durable provider dispatch',
  { timeout: 30_000 },
  async (t) => {
    const boundary = await createNativeSearchProviderBoundary(t);
    const searchArgs = {
      query: 'current TypeScript docs',
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-native-search-replacement',
    };

    const firstCommandHost = boundary.createRuntime();
    const first = createNativeSearchTestRuntime(boundary, firstCommandHost);
    const firstSearch = first.runtime.search(searchArgs);
    await boundary.firstDispatch;

    await first.sessions.closeAll();
    const detachedOutcome = await firstSearch;
    assert.equal(detachedOutcome.ok, false);
    await boundary.closeRuntime(firstCommandHost);

    const replacementCommandHost = boundary.createRuntime();
    const replacement = createNativeSearchTestRuntime(
      boundary,
      replacementCommandHost,
    );
    const replacementSearch = replacement.runtime.search(searchArgs);
    boundary.releaseProvider();
    const result = await replacementSearch;

    assert.deepEqual(result, {
      ok: true,
      answer: 'Current docs',
      results: [
        {
          title: 'TypeScript Handbook',
          url: 'https://www.typescriptlang.org/docs/handbook/',
          snippet: 'Current docs',
        },
      ],
    });
    assert.deepEqual(await replacement.runtime.search(searchArgs), result);
    assert.equal(boundary.dispatchCount(), 1);
    assert.equal(
      boundary.observedAuthorization(),
      'Bearer native-search-secret',
    );
    assert.deepEqual(boundary.requestPayloads(), [
      {
        type: 'response.create',
        model: 'gpt-5.6-sol',
        store: false,
        stream: true,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'current TypeScript docs' }],
          },
        ],
        tools: [{ type: 'web_search', search_context_size: 'high' }],
        tool_choice: { type: 'web_search' },
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /native-search-secret|native-search-account/u,
    );

    await replacement.sessions.closeAll();
    await boundary.closeRuntime(replacementCommandHost);
  },
);

async function createNativeSearchProviderBoundary(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<NativeSearchProviderBoundary> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-native-search-owner-'),
  );
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const runtimes = new Set<NativeSearchWorkerRuntime>();
  const payloads: Record<string, unknown>[] = [];
  let authorization: string | undefined;
  let providerDispatches = 0;
  let resolveFirstDispatch: () => void = () => undefined;
  const firstDispatch = new Promise<void>((resolve) => {
    resolveFirstDispatch = resolve;
  });
  let releaseProvider: () => void = () => undefined;
  const continueProvider = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  server.on('connection', (socket, request) => {
    authorization = request.headers.authorization;
    socket.once('message', (message) => {
      providerDispatches += 1;
      payloads.push(JSON.parse(message.toString()) as Record<string, unknown>);
      socket.send(
        JSON.stringify({
          type: 'response.output_item.added',
          item: { id: 'native-search-message', type: 'message' },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.output_text.delta',
          item_id: 'native-search-message',
          delta: 'Current ',
          credential: 'native-search-secret',
        }),
      );
      resolveFirstDispatch();
      void continueProvider.then(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            item_id: 'native-search-message',
            delta: 'docs',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_item.done',
            item: {
              id: 'native-search-message',
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Current docs',
                  annotations: [
                    {
                      type: 'url_citation',
                      title: 'TypeScript Handbook',
                      url: 'https://www.typescriptlang.org/docs/handbook/',
                      start_index: 0,
                      end_index: 12,
                    },
                  ],
                },
              ],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { usage: { input_tokens: 2, output_tokens: 2 } },
          }),
        );
      });
    });
  });

  t.after(async () => {
    releaseProvider();
    for (const runtime of runtimes) {
      await runtime.closeAll().catch(() => undefined);
    }
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeCommandHostWorkspace(stateRoot);
  });

  return {
    stateRoot,
    webSocketUrl: `ws://127.0.0.1:${address.port}/responses`,
    firstDispatch,
    createRuntime() {
      const runtime = createNativeSearchWorkerRuntime();
      runtimes.add(runtime);
      return runtime;
    },
    async closeRuntime(runtime) {
      runtimes.delete(runtime);
      await runtime.closeAll();
    },
    dispatchCount: () => providerDispatches,
    observedAuthorization: () => authorization,
    requestPayloads: () => payloads,
    releaseProvider,
  };
}

function createNativeSearchTestRuntime(
  boundary: NativeSearchProviderBoundary,
  hostCommands: NativeSearchWorkerRuntime,
) {
  const durableRequestTransport = createHostRoutedResponsesRequestTransport({
    stateRoot: boundary.stateRoot,
    startProcess: createHostRoutedDetachedProcessStarter({
      hostCommands,
      stateRoot: boundary.stateRoot,
      pageLimitBytes: 64 * 1024,
      cwd: boundary.stateRoot,
      env: process.env,
      runId: 'native-search-provider-test',
    }),
    attachProcess: createHostRoutedDetachedProcessAttacher({
      hostCommands,
      stateRoot: boundary.stateRoot,
      pageLimitBytes: 64 * 1024,
    }),
    resolveTerminalArtifactPath: (outputRef) =>
      join(
        buildHostCommandPaths({
          stateRoot: boundary.stateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          outputRef,
        }).directory,
        'responses-terminal.json',
      ),
  });
  const sessions = createResponsesWebSocketSessionStore({
    durableRequestTransport,
  });
  const runtime = createCodexWebSearchRuntime({
    authRuntime: createProviderAuthRuntimeStore(),
    webSocketSessions: sessions,
    dependencies: {
      getAuth: async () => ({
        accessToken: 'native-search-secret',
        accountId: 'native-search-account',
      }),
      streamResponses: (input) =>
        streamResponsesOverWebSocket({
          ...input,
          webSocketUrl: boundary.webSocketUrl,
        }),
    },
  });
  return { runtime, sessions };
}

function createNativeSearchWorkerRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 64 * 1024, tailRingBytes: 64 * 1024 },
    requestedMode: 'worker',
    workerCommand: nativeSearchCommandHostWorkerCommand(),
  });
}

function nativeSearchCommandHostWorkerCommand(): NodeModuleCommand {
  const source = fileURLToPath(
    new URL('../../../command-host/main.ts', import.meta.url),
  );
  const built = fileURLToPath(
    new URL('../../../command-host/main.js', import.meta.url),
  );
  return existsSync(built)
    ? { execPath: process.execPath, args: [built] }
    : {
        execPath: process.execPath,
        args: ['--import', fileURLToPath(import.meta.resolve('tsx')), source],
      };
}
