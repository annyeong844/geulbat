import { pathToFileURL } from 'node:url';

import {
  RESPONSES_DURABLE_REQUEST_FRAME_PREFIX,
  RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
  RESPONSES_DURABLE_REQUEST_REDACTION_REPLACEMENT,
  encodeResponsesDurableRequestFrame,
  parseResponsesDurableRequestInputFrame,
  serializeResponsesDurableRequestError,
  type ResponsesDurableRequestFrame,
  type ResponsesDurableRequestInputFrame,
  type ResponsesDurableRequestSerializedError,
  type ResponsesDurableRequestTerminalArtifact,
} from './responses-durable-request-protocol.js';
import {
  closeWebSocketSilently,
  connectWebSocket,
  parseRetryAfterMs,
} from './responses-websocket-connection.js';
import { iterateWebSocketEventsAfterDispatch } from './responses-websocket-stream.js';
import { iterateJsonServerSentEvents } from './json-server-sent-events.js';
import { writeTextFileAtomically } from '../../../utils/atomic-file.js';
import { runDetached } from '../../../utils/run-detached.js';

type InitializedRequest = Extract<
  ResponsesDurableRequestInputFrame,
  { kind: 'initialize' }
>;

interface TerminalState {
  artifact: ResponsesDurableRequestTerminalArtifact;
  exitCode: number;
}

async function runResponsesDurableRequestHost(): Promise<number> {
  process.stdin.setEncoding('utf8');
  let inputBuffer = '';
  let initialized: InitializedRequest | undefined;
  let terminalArtifactPath: string | undefined;
  let activeSubscriptionId: string | undefined;
  let dispatched = false;
  let terminal: TerminalState | undefined;
  let dispatchPromise: Promise<void> | undefined;
  let outputChain = Promise.resolve();
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const observedEvents: Record<string, unknown>[] = [];

  const enqueueFrame = (frame: ResponsesDurableRequestFrame): void => {
    const encoded = `${encodeResponsesDurableRequestFrame(frame)}${'\0'.repeat(
      Math.max(
        0,
        ...(initialized?.redactionMarkers ?? []).map((marker) => marker.length),
      ),
    )}\n`;
    outputChain = outputChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(encoded, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    );
  };

  const enqueueReplay = (): void => {
    if (
      initialized === undefined ||
      activeSubscriptionId === undefined ||
      !dispatched
    ) {
      return;
    }
    const common = {
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      requestIdentity: initialized.requestIdentity,
      subscriptionId: activeSubscriptionId,
    } as const;
    enqueueFrame({ ...common, kind: 'accepted' });
    for (const event of terminal?.artifact.events ?? observedEvents) {
      enqueueFrame({ ...common, kind: 'event', event });
    }
    if (terminal?.artifact.terminal.kind === 'completed') {
      enqueueFrame({ ...common, kind: 'completed' });
    } else if (terminal?.artifact.terminal.kind === 'failed') {
      enqueueFrame({
        ...common,
        kind: 'failed',
        error: terminal.artifact.terminal.error,
      });
    }
  };

  const settle = async (
    terminalKind:
      | { kind: 'completed' }
      | { kind: 'failed'; error: ResponsesDurableRequestSerializedError },
  ): Promise<void> => {
    if (initialized === undefined || terminalArtifactPath === undefined) {
      return;
    }
    let nextTerminal: TerminalState = {
      artifact: {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        requestIdentity: initialized.requestIdentity,
        dispatched,
        events: observedEvents,
        terminal: terminalKind,
      },
      exitCode: terminalKind.kind === 'completed' ? 0 : 1,
    };
    try {
      await writeTextFileAtomically(
        terminalArtifactPath,
        JSON.stringify(nextTerminal.artifact),
        { mode: 0o600 },
      );
    } catch {
      nextTerminal = {
        artifact: {
          version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
          requestIdentity: initialized.requestIdentity,
          dispatched,
          events: observedEvents,
          terminal: {
            kind: 'failed',
            error: {
              message:
                'provider request terminal artifact could not be committed',
              llmCode: 'llm_durable_result_store_failed',
            },
          },
        },
        exitCode: 1,
      };
    }
    terminal = nextTerminal;
    resolveFinished();
    const subscriptionId = activeSubscriptionId;
    if (subscriptionId !== undefined) {
      const common = {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        requestIdentity: initialized.requestIdentity,
        subscriptionId,
      } as const;
      if (nextTerminal.artifact.terminal.kind === 'completed') {
        enqueueFrame({ ...common, kind: 'completed' });
      } else {
        enqueueFrame({
          ...common,
          kind: 'failed',
          error: nextTerminal.artifact.terminal.error,
        });
      }
    }
    await outputChain;
  };

  const recordEvent = (
    request: InitializedRequest,
    event: Record<string, unknown>,
  ): void => {
    const redactedEvent = redactProviderEvent(event, request.redactionMarkers);
    observedEvents.push(redactedEvent);
    if (activeSubscriptionId !== undefined) {
      enqueueFrame({
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        kind: 'event',
        requestIdentity: request.requestIdentity,
        subscriptionId: activeSubscriptionId,
        event: redactedEvent,
      });
    }
  };

  const dispatch = async (): Promise<void> => {
    if (initialized === undefined || terminalArtifactPath === undefined) {
      return;
    }
    const request = initialized;
    let socket: Awaited<ReturnType<typeof connectWebSocket>> | undefined;
    try {
      if (request.transportKind === 'websocket') {
        socket = await connectWebSocket(
          request.webSocketUrl,
          new Headers(request.headers),
        );
        const connectedSocket = socket;
        for await (const event of iterateWebSocketEventsAfterDispatch(
          connectedSocket,
          () => {
            connectedSocket.send(request.serializedPayload);
            dispatched = true;
            enqueueReplay();
          },
          undefined,
          request.completionEventTypes,
        )) {
          recordEvent(request, event);
        }
      } else {
        dispatched = true;
        enqueueReplay();
        const response = await fetch(request.requestUrl, {
          method: 'POST',
          headers: new Headers(request.headers),
          body: request.serializedPayload,
        });
        if (!response.ok) {
          throw createHttpResponseError(response);
        }
        const contentType = response.headers.get('content-type');
        if (contentType?.toLowerCase().includes('text/event-stream') !== true) {
          throw Object.assign(
            new Error(
              `provider HTTP response is not an event stream (content-type: ${contentType ?? 'missing'})`,
            ),
            { status: response.status },
          );
        }
        if (response.body === null) {
          throw Object.assign(
            new Error('provider HTTP event stream body is missing'),
            { status: response.status },
          );
        }
        for await (const event of iterateJsonServerSentEvents(response.body)) {
          recordEvent(request, event);
        }
      }
      await settle({ kind: 'completed' });
    } catch (error: unknown) {
      await settle({
        kind: 'failed',
        error: redactSerializedError(
          serializeResponsesDurableRequestError(error),
          request.redactionMarkers,
        ),
      });
    } finally {
      if (socket !== undefined) {
        closeWebSocketSilently(socket, 1000, 'request_complete');
      }
    }
  };

  const handleFrame = (frame: ResponsesDurableRequestInputFrame): void => {
    if (frame.kind === 'initialize') {
      initialized ??= frame;
      return;
    }
    if (
      initialized === undefined ||
      frame.requestIdentity !== initialized.requestIdentity
    ) {
      return;
    }
    if (
      terminalArtifactPath !== undefined &&
      terminalArtifactPath !== frame.terminalArtifactPath
    ) {
      enqueueFrame({
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        kind: 'failed',
        requestIdentity: initialized.requestIdentity,
        subscriptionId: frame.subscriptionId,
        error: {
          message: 'provider request terminal artifact path changed',
          llmCode: 'llm_durable_request_identity_conflict',
        },
      });
      return;
    }
    terminalArtifactPath = frame.terminalArtifactPath;
    activeSubscriptionId = frame.subscriptionId;
    if (terminal !== undefined || dispatched) {
      enqueueReplay();
      return;
    }
    dispatchPromise ??= dispatch();
  };

  process.stdin.on('data', (chunk: string) => {
    inputBuffer += chunk;
    for (;;) {
      const newlineIndex = inputBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }
      const line = inputBuffer.slice(0, newlineIndex);
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      const frame = parseFramedInputLine(line);
      if (frame !== undefined) {
        handleFrame(frame);
      }
    }
  });

  await finished;
  await dispatchPromise;
  await outputChain;
  process.stdin.destroy();
  return terminal?.exitCode ?? 1;
}

function createHttpResponseError(response: Response): Error {
  const retryAfterMs = parseRetryAfterMs(
    response.headers.get('retry-after') ?? undefined,
    Date.now(),
  );
  return Object.assign(
    new Error(`provider HTTP request failed with status ${response.status}`),
    {
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

function redactProviderEvent(
  event: Record<string, unknown>,
  markers: readonly string[],
): Record<string, unknown> {
  return redactProviderValue(event, markers) as Record<string, unknown>;
}

function redactProviderValue(
  value: unknown,
  markers: readonly string[],
): unknown {
  if (typeof value === 'string') {
    return redactString(value, markers);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderValue(item, markers));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactString(key, markers),
        redactProviderValue(item, markers),
      ]),
    );
  }
  return value;
}

function redactSerializedError(
  error: ResponsesDurableRequestSerializedError,
  markers: readonly string[],
): ResponsesDurableRequestSerializedError {
  return { ...error, message: redactString(error.message, markers) };
}

function redactString(value: string, markers: readonly string[]): string {
  let redacted = value;
  for (const marker of markers) {
    if (marker.length > 0) {
      redacted = redacted.replaceAll(
        marker,
        RESPONSES_DURABLE_REQUEST_REDACTION_REPLACEMENT,
      );
    }
  }
  return redacted;
}

function parseFramedInputLine(
  line: string,
): ResponsesDurableRequestInputFrame | undefined {
  let prefixIndex = line.lastIndexOf(RESPONSES_DURABLE_REQUEST_FRAME_PREFIX);
  while (prefixIndex >= 0) {
    try {
      const parsed: unknown = JSON.parse(
        line.slice(prefixIndex + RESPONSES_DURABLE_REQUEST_FRAME_PREFIX.length),
      );
      const frame = parseResponsesDurableRequestInputFrame(parsed);
      if (frame !== undefined) {
        return frame;
      }
    } catch {
      // A previous daemon may have died after writing only a prefix fragment.
      // Search an earlier prefix; a complete replayed frame still follows it.
    }
    prefixIndex = line.lastIndexOf(
      RESPONSES_DURABLE_REQUEST_FRAME_PREFIX,
      prefixIndex - 1,
    );
  }
  return undefined;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  runDetached('provider/responses-durable-request-host', async () => {
    try {
      process.exitCode = await runResponsesDurableRequestHost();
    } catch (error: unknown) {
      // 원인을 지우지 않는다. 이 호스트는 별도 프로세스이고, 여기서 버린 원인은
      // 어디에도 남지 않는다. 데몬은 호스트가 죽은 것만 보고, 사용자는
      // `[internal] provider request failed`만 받는다.
      process.stderr.write(
        `provider request host failed: ${
          error instanceof Error
            ? (error.stack ?? `${error.name}: ${error.message}`)
            : String(error)
        }\n`,
      );
      process.exitCode = 1;
    }
  });
}
