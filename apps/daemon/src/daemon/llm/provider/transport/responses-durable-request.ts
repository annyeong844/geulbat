import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeTextFileAtomically } from '../../../utils/atomic-file.js';
import {
  RESPONSES_DURABLE_REQUEST_FRAME_PREFIX,
  RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
  RESPONSES_DURABLE_REQUEST_REDACTION_REPLACEMENT,
  encodeResponsesDurableRequestFrame,
  hydrateResponsesDurableRequestError,
  parseResponsesDurableRequestFrame,
  parseResponsesDurableRequestTerminalArtifact,
  type ResponsesDurableRequestFrame,
  type ResponsesDurableRequestInputFrame,
  type ResponsesDurableRequestTerminalArtifact,
} from './responses-durable-request-protocol.js';

export interface ResponsesDurableRequestStreamArgs {
  webSocketUrl: string;
  headers: Headers;
  serializedPayload: string;
  providerSessionId: string;
  requestAttempt: number;
  completionEventTypes?: readonly string[];
  onDispatched?: () => void;
  signal?: AbortSignal;
}

export interface DurableHttpSseRequestStreamArgs {
  requestUrl: string;
  headers: Headers;
  serializedPayload: string;
  providerSessionId: string;
  requestAttempt: number;
  onDispatched?: () => void;
  signal?: AbortSignal;
}

type DurableProviderRequestStreamArgs =
  | ResponsesDurableRequestStreamArgs
  | DurableHttpSseRequestStreamArgs;

export interface ResponsesDurableRequestTransport {
  streamEvents(
    args: ResponsesDurableRequestStreamArgs,
  ): AsyncIterable<Record<string, unknown>>;
  streamHttpSseEvents?(
    args: DurableHttpSseRequestStreamArgs,
  ): AsyncIterable<Record<string, unknown>>;
}

interface ResponsesDurableRequestActiveOutputs {
  activeOutputRefs(
    stateRoot: string,
  ): Promise<
    { ok: true; refs: ReadonlySet<string> } | { ok: false; reason: string }
  >;
}

interface ResponsesDurableRequestProcessHandle {
  readonly outputRef: string;
  readonly exit: Promise<unknown>;
  drainNewOutput(): { stdout: string; stderr: string };
  getOutputRevision(): number;
  waitForOutputChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number>;
  writeInput(
    chars: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  stop(): void;
}

interface ResponsesDurableRequestProcessInvocation {
  callId: string;
  executable: string;
  args: readonly string[];
  stdinMode: 'open';
  initialStdin: string;
  redactionMarkers: readonly string[];
  redactionReplacement: string;
}

type ResponsesDurableRequestProcessStartResult =
  | { ok: true; handle: ResponsesDurableRequestProcessHandle }
  | { ok: false; message: string };

type StartProcess = (
  invocation: ResponsesDurableRequestProcessInvocation,
) => Promise<ResponsesDurableRequestProcessStartResult>;
type AttachProcess = (invocation: {
  outputRef: string;
}) => Promise<ResponsesDurableRequestProcessStartResult>;
type StartedHandle = Extract<
  ResponsesDurableRequestProcessStartResult,
  { ok: true }
>['handle'];

interface DurableRequestCoordinate {
  version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
  requestIdentity: string;
  outputRef: string;
}

interface WorkerCommand {
  execPath: string;
  args: readonly string[];
}

export function createHostRoutedResponsesRequestTransport(args: {
  stateRoot: string;
  startProcess: StartProcess;
  attachProcess: AttachProcess;
  resolveTerminalArtifactPath: (outputRef: string) => string;
  workerCommand?: WorkerCommand;
}): ResponsesDurableRequestTransport & ResponsesDurableRequestActiveOutputs {
  const coordinateRoot = join(
    args.stateRoot,
    '.geulbat',
    'provider-request-coordinates',
  );

  return {
    streamEvents: (input) => streamRequestEvents(input),
    streamHttpSseEvents: (input) => streamRequestEvents(input),
    async activeOutputRefs(stateRoot) {
      if (stateRoot !== args.stateRoot) {
        return { ok: true, refs: new Set<string>() };
      }
      let entries: string[];
      try {
        entries = await readdir(coordinateRoot);
      } catch (error: unknown) {
        return isMissingFileError(error)
          ? { ok: true, refs: new Set<string>() }
          : {
              ok: false,
              reason: 'provider request coordinates could not be listed',
            };
      }
      const refs = new Set<string>();
      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        const coordinate = await readCoordinate(join(coordinateRoot, entry));
        if (coordinate.kind !== 'value') {
          return {
            ok: false,
            reason: 'provider request coordinate could not be read',
          };
        }
        refs.add(coordinate.value.outputRef);
      }
      return { ok: true, refs };
    },
  };

  async function* streamRequestEvents(
    input: DurableProviderRequestStreamArgs,
  ): AsyncGenerator<Record<string, unknown>> {
    let dispatchObserved = false;
    const observeDispatched = (): void => {
      if (dispatchObserved) {
        return;
      }
      dispatchObserved = true;
      input.onDispatched?.();
    };
    const observeTerminalDispatch = (
      artifact: ResponsesDurableRequestTerminalArtifact,
    ): void => {
      if (artifact.dispatched) {
        observeDispatched();
      }
    };
    const requestIdentity = buildRequestIdentity(input);
    const coordinatePath = join(
      coordinateRoot,
      `${buildProviderSessionKey(input)}.json`,
    );
    const existing = await readCoordinate(coordinatePath);
    if (existing.kind === 'invalid') {
      throw new Error('provider request coordinate is unreadable');
    }

    let handle: StartedHandle;
    let outputRef: string;
    if (
      existing.kind === 'value' &&
      existing.value.requestIdentity === requestIdentity
    ) {
      outputRef = existing.value.outputRef;
      const terminal = await readTerminalArtifact(
        args.resolveTerminalArtifactPath(outputRef),
        requestIdentity,
      );
      if (terminal.kind === 'value') {
        observeTerminalDispatch(terminal.value);
        yield* replayTerminalArtifact(terminal.value, 0);
        return;
      }
      if (terminal.kind === 'invalid') {
        throw new Error('provider request terminal artifact is unreadable');
      }
      const attached = await args.attachProcess({ outputRef });
      if (!attached.ok) {
        const afterAttach = await readTerminalArtifact(
          args.resolveTerminalArtifactPath(outputRef),
          requestIdentity,
        );
        if (afterAttach.kind === 'value') {
          observeTerminalDispatch(afterAttach.value);
          yield* replayTerminalArtifact(afterAttach.value, 0);
          return;
        }
        throw outcomeUnknownError(attached.message);
      }
      handle = attached.handle;
    } else {
      if (existing.kind === 'value') {
        const previous = await readTerminalArtifact(
          args.resolveTerminalArtifactPath(existing.value.outputRef),
          existing.value.requestIdentity,
        );
        if (previous.kind !== 'value') {
          throw new Error(
            'provider session already has an unresolved durable request',
          );
        }
      }
      const workerCommand =
        args.workerCommand ?? resolveResponsesDurableRequestWorkerCommand();
      if (workerCommand === undefined) {
        throw new Error('provider request host entry was not found');
      }
      const redactionMarkers = buildSensitiveProviderHeaderMarkers(
        input.headers,
      );
      const initialized = await args.startProcess({
        callId: requestIdentity,
        executable: workerCommand.execPath,
        args: workerCommand.args,
        stdinMode: 'open',
        initialStdin: encodeResponsesDurableRequestFrame(
          buildInitializeFrame(input, requestIdentity, redactionMarkers),
        ),
        redactionMarkers,
        redactionReplacement: RESPONSES_DURABLE_REQUEST_REDACTION_REPLACEMENT,
      });
      if (!initialized.ok) {
        throw new Error(
          `provider request host start failed: ${initialized.message}`,
        );
      }
      handle = initialized.handle;
      outputRef = handle.outputRef;
      const coordinate: DurableRequestCoordinate = {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        requestIdentity,
        outputRef,
      };
      try {
        await writeTextFileAtomically(
          coordinatePath,
          JSON.stringify(coordinate),
          { mode: 0o600 },
        );
      } catch (error: unknown) {
        handle.stop();
        throw error;
      }
    }

    const artifactPath = args.resolveTerminalArtifactPath(outputRef);
    const subscriptionId = randomUUID();
    const committed = await handle.writeInput(
      encodeResponsesDurableRequestFrame({
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        kind: 'commit',
        requestIdentity,
        subscriptionId,
        terminalArtifactPath: artifactPath,
      }),
    );
    if (!committed.ok) {
      const terminal = await readTerminalArtifact(
        artifactPath,
        requestIdentity,
      );
      if (terminal.kind === 'value') {
        observeTerminalDispatch(terminal.value);
        yield* replayTerminalArtifact(terminal.value, 0);
        return;
      }
      throw outcomeUnknownError(committed.message);
    }

    let stdoutBuffer = '';
    let deliveredEvents = 0;
    let reachedTerminal = false;
    try {
      for (;;) {
        const drained = handle.drainNewOutput();
        stdoutBuffer += drained.stdout;
        const decoded = decodeOutputFrames(stdoutBuffer);
        stdoutBuffer = decoded.remainder;
        for (const frame of decoded.frames) {
          if (
            frame.requestIdentity !== requestIdentity ||
            frame.subscriptionId !== subscriptionId
          ) {
            continue;
          }
          if (frame.kind === 'accepted') {
            observeDispatched();
            continue;
          }
          if (frame.kind === 'event') {
            deliveredEvents += 1;
            yield frame.event;
            continue;
          }
          if (frame.kind === 'completed' || frame.kind === 'failed') {
            const terminal = await readTerminalArtifact(
              artifactPath,
              requestIdentity,
            );
            if (terminal.kind === 'value') {
              observeTerminalDispatch(terminal.value);
              yield* replayTerminalArtifact(terminal.value, deliveredEvents);
              reachedTerminal = true;
              return;
            }
            if (frame.kind === 'failed') {
              reachedTerminal = true;
              throw hydrateResponsesDurableRequestError(frame.error);
            }
            throw new Error(
              'provider request completed without a durable terminal artifact',
            );
          }
        }

        const revision = handle.getOutputRevision();
        const wake = await Promise.race([
          handle
            .waitForOutputChange(revision, input.signal)
            .then(() => ({ kind: 'output' as const })),
          handle.exit.then((exit) => ({ kind: 'exit' as const, exit })),
        ]);
        if (wake.kind === 'exit') {
          const finalOutput = handle.drainNewOutput();
          stdoutBuffer += finalOutput.stdout;
          const finalFrames = decodeOutputFrames(stdoutBuffer);
          stdoutBuffer = finalFrames.remainder;
          for (const frame of finalFrames.frames) {
            if (
              frame.requestIdentity !== requestIdentity ||
              frame.subscriptionId !== subscriptionId
            ) {
              continue;
            }
            if (frame.kind === 'accepted') {
              observeDispatched();
            } else if (frame.kind === 'event') {
              deliveredEvents += 1;
              yield frame.event;
            }
          }
          const terminal = await readTerminalArtifact(
            artifactPath,
            requestIdentity,
          );
          if (terminal.kind === 'value') {
            observeTerminalDispatch(terminal.value);
            yield* replayTerminalArtifact(terminal.value, deliveredEvents);
            reachedTerminal = true;
            return;
          }
          throw outcomeUnknownError(
            `provider request host exited (${describeProcessExit(wake.exit)})`,
          );
        }
      }
    } finally {
      if (!reachedTerminal && !isDetachOnlyReason(input.signal?.reason)) {
        handle.stop();
        await clearCoordinateIfOwned({
          coordinatePath,
          requestIdentity,
          outputRef,
        });
      }
    }
  }
}

function buildInitializeFrame(
  input: DurableProviderRequestStreamArgs,
  requestIdentity: string,
  redactionMarkers: string[],
): Extract<ResponsesDurableRequestInputFrame, { kind: 'initialize' }> {
  const common = {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    kind: 'initialize' as const,
    requestIdentity,
    headers: [...input.headers.entries()] as [string, string][],
    serializedPayload: input.serializedPayload,
    redactionMarkers,
  };
  if (isWebSocketRequest(input)) {
    return {
      ...common,
      transportKind: 'websocket',
      webSocketUrl: input.webSocketUrl,
      ...(input.completionEventTypes === undefined
        ? {}
        : { completionEventTypes: [...input.completionEventTypes] }),
    };
  }
  return {
    ...common,
    transportKind: 'http_json_sse',
    requestUrl: input.requestUrl,
  };
}

function buildRequestIdentity(input: DurableProviderRequestStreamArgs): string {
  const transportIdentity = isWebSocketRequest(input)
    ? {
        transportKind: 'websocket' as const,
        endpointUrl: input.webSocketUrl,
        completionEventTypes: input.completionEventTypes ?? null,
      }
    : {
        transportKind: 'http_json_sse' as const,
        endpointUrl: input.requestUrl,
      };
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...transportIdentity,
        providerSessionId: input.providerSessionId,
        requestAttempt: input.requestAttempt,
        serializedPayload: input.serializedPayload,
        semanticHeaders: buildSemanticProviderHeaders(input.headers),
      }),
    )
    .digest('hex');
}

function buildProviderSessionKey(
  input: DurableProviderRequestStreamArgs,
): string {
  const transportIdentity = isWebSocketRequest(input)
    ? {
        transportKind: 'websocket' as const,
        endpointUrl: input.webSocketUrl,
      }
    : {
        transportKind: 'http_json_sse' as const,
        endpointUrl: input.requestUrl,
      };
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...transportIdentity,
        providerSessionId: input.providerSessionId,
      }),
    )
    .digest('hex');
}

function buildSemanticProviderHeaders(headers: Headers): [string, string][] {
  return [...headers.entries()]
    .filter(([name]) => !isSensitiveProviderHeaderName(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder = leftName.localeCompare(rightName);
      return nameOrder === 0 ? leftValue.localeCompare(rightValue) : nameOrder;
    });
}

function isWebSocketRequest(
  input: DurableProviderRequestStreamArgs,
): input is ResponsesDurableRequestStreamArgs {
  return 'webSocketUrl' in input;
}

function resolveResponsesDurableRequestWorkerCommand():
  | WorkerCommand
  | undefined {
  const sibling = fileURLToPath(
    new URL('./responses-durable-request-host-main.js', import.meta.url),
  );
  if (existsSync(sibling)) {
    return { execPath: process.execPath, args: [sibling] };
  }
  const bundleEntry = process.argv[1];
  if (bundleEntry === undefined) {
    return undefined;
  }
  const bundled = join(dirname(bundleEntry), 'responses-request-host.mjs');
  return existsSync(bundled)
    ? { execPath: process.execPath, args: [bundled] }
    : undefined;
}

function decodeOutputFrames(buffer: string): {
  frames: ResponsesDurableRequestFrame[];
  remainder: string;
} {
  const frames: ResponsesDurableRequestFrame[] = [];
  let remainder = buffer;
  for (;;) {
    const newlineIndex = remainder.indexOf('\n');
    if (newlineIndex < 0) {
      return { frames, remainder };
    }
    const line = remainder.slice(0, newlineIndex);
    remainder = remainder.slice(newlineIndex + 1);
    let prefixIndex = line.lastIndexOf(RESPONSES_DURABLE_REQUEST_FRAME_PREFIX);
    while (prefixIndex >= 0) {
      try {
        const parsed: unknown = JSON.parse(
          line.slice(
            prefixIndex + RESPONSES_DURABLE_REQUEST_FRAME_PREFIX.length,
          ),
        );
        const frame = parseResponsesDurableRequestFrame(parsed);
        if (frame !== undefined) {
          frames.push(frame);
          break;
        }
      } catch {
        // Search an earlier prefix. This recovers when an earlier daemon died
        // after writing only part of one control line.
      }
      prefixIndex = line.lastIndexOf(
        RESPONSES_DURABLE_REQUEST_FRAME_PREFIX,
        prefixIndex - 1,
      );
    }
  }
}

async function* replayTerminalArtifact(
  artifact: ResponsesDurableRequestTerminalArtifact,
  deliveredEvents: number,
): AsyncGenerator<Record<string, unknown>> {
  if (deliveredEvents > artifact.events.length) {
    throw new Error('provider request event replay diverged from its artifact');
  }
  for (const event of artifact.events.slice(deliveredEvents)) {
    yield event;
  }
  if (artifact.terminal.kind === 'failed') {
    throw hydrateResponsesDurableRequestError(artifact.terminal.error);
  }
}

async function readTerminalArtifact(
  path: string,
  requestIdentity: string,
): Promise<
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: ResponsesDurableRequestTerminalArtifact }
> {
  let serialized: string;
  try {
    serialized = await readFile(path, 'utf8');
  } catch (error: unknown) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }
  try {
    const artifact = parseResponsesDurableRequestTerminalArtifact(
      JSON.parse(serialized) as unknown,
    );
    return artifact === undefined ||
      artifact.requestIdentity !== requestIdentity
      ? { kind: 'invalid' }
      : { kind: 'value', value: artifact };
  } catch {
    return { kind: 'invalid' };
  }
}

async function readCoordinate(
  path: string,
): Promise<
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: DurableRequestCoordinate }
> {
  let serialized: string;
  try {
    serialized = await readFile(path, 'utf8');
  } catch (error: unknown) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      value === null ||
      typeof value !== 'object' ||
      Reflect.get(value, 'version') !==
        RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION ||
      typeof Reflect.get(value, 'requestIdentity') !== 'string' ||
      typeof Reflect.get(value, 'outputRef') !== 'string'
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'value',
      value: {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        requestIdentity: Reflect.get(value, 'requestIdentity') as string,
        outputRef: Reflect.get(value, 'outputRef') as string,
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

async function clearCoordinateIfOwned(args: {
  coordinatePath: string;
  requestIdentity: string;
  outputRef: string;
}): Promise<void> {
  const coordinate = await readCoordinate(args.coordinatePath);
  if (
    coordinate.kind === 'value' &&
    coordinate.value.requestIdentity === args.requestIdentity &&
    coordinate.value.outputRef === args.outputRef
  ) {
    await unlink(args.coordinatePath).catch(() => undefined);
  }
}

function isDetachOnlyReason(reason: unknown): boolean {
  return (
    reason === 'daemon_shutdown' ||
    (reason instanceof Error &&
      reason.message === 'responses websocket session store is closed')
  );
}

function describeProcessExit(exit: unknown): string {
  if (exit === null || typeof exit !== 'object') {
    return 'unknown';
  }
  const kind = Reflect.get(exit, 'kind');
  const exitCode = Reflect.get(exit, 'exitCode');
  const message = Reflect.get(exit, 'message');
  return `${typeof kind === 'string' ? kind : 'unknown'}:${
    typeof exitCode === 'number' ? String(exitCode) : 'none'
  }${typeof message === 'string' ? `:${message}` : ''}`;
}

function outcomeUnknownError(detail: string): Error {
  return Object.assign(
    new Error(`provider request outcome is unknown: ${detail}`),
    { llmCode: 'llm_provider_request_outcome_unknown' as const },
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function buildSensitiveProviderHeaderMarkers(headers: Headers): string[] {
  const markers: string[] = [];
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (!isSensitiveProviderHeaderName(normalizedName)) {
      continue;
    }
    markers.push(value);
    if (normalizedName === 'authorization') {
      const bearer = /^Bearer\s+(.+)$/iu.exec(value)?.[1];
      if (bearer !== undefined) {
        markers.push(bearer);
      }
    }
  }
  return [...new Set(markers)];
}

function isSensitiveProviderHeaderName(name: string): boolean {
  return [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'api-key',
    'x-api-key',
    'chatgpt-account-id',
    'x-grok-conv-id',
  ].includes(name.toLowerCase());
}
