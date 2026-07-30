import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_HOST_CAPABILITIES,
  DEFAULT_MAX_FRAME_BYTES,
  FrameDecoder,
  FrameTooLargeError,
  buildErrorResponse,
  buildRequest,
  buildResultResponse,
  encodeFrame,
  initializeParamsSchema,
  initializeResultSchema,
  interactResultSchema,
  interactParamsSchema,
  jsonRpcRequestSchema,
  REQUEST_CANCELLED_CODE,
  startResultSchema,
  startParamsSchema,
  subscribeResultSchema,
  waitInitialParamsSchema,
  waitInitialResultSchema,
} from './protocol.js';

void test('framing round-trips messages split across arbitrary chunk boundaries', () => {
  const messages = [
    buildRequest(1, 'session/start', { cwd: '/tmp' }),
    buildResultResponse(1, { ok: true, outputRef: 'command-output:t/s' }),
    buildErrorResponse(2, REQUEST_CANCELLED_CODE, 'cancelled'),
  ];
  const wire = Buffer.concat(messages.map((message) => encodeFrame(message)));

  const decoder = new FrameDecoder();
  const received: unknown[] = [];
  const byteLengths: number[] = [];
  // 바이트를 1개씩 흘려도 프레임 경계에서만 완결 메시지가 나온다.
  for (const byte of wire) {
    for (const frame of decoder.push(Buffer.from([byte]))) {
      received.push(frame.message);
      byteLengths.push(frame.byteLength);
    }
  }
  assert.deepEqual(received, messages);
  // §7.5 전역 inflight 예산이 세는 단위는 길이 프리픽스를 포함한 wire 크기다.
  assert.deepEqual(
    byteLengths,
    messages.map((message) => encodeFrame(message).length),
  );
  assert.equal(decoder.bufferedBytes, 0);
});

void test('framing coalesces multiple frames in one chunk', () => {
  const a = encodeFrame(buildRequest('x', 'ping'));
  const b = encodeFrame(buildRequest('y', 'pong'));
  const decoder = new FrameDecoder();
  const out = decoder.push(Buffer.concat([a, b]));
  assert.equal(out.length, 2);
});

void test('framing rejects an over-limit declared length before allocation', () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(DEFAULT_MAX_FRAME_BYTES + 1, 0);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(oversized), FrameTooLargeError);
});

void test('a partial length prefix is buffered without throwing', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0, 0])), []);
  assert.equal(decoder.bufferedBytes, 2);
});

void test('jsonRpcRequestSchema accepts string and numeric ids', () => {
  assert.equal(
    jsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/interact',
    }).success,
    true,
  );
  assert.equal(
    jsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 7, method: 'x' })
      .success,
    false,
  );
});

void test('method param schemas validate required shapes', () => {
  assert.equal(
    initializeParamsSchema.safeParse({
      protocolVersion: '2026-07-24',
      stateRootFingerprint: 'abc',
    }).success,
    true,
  );
  assert.equal(
    startParamsSchema.safeParse({
      executable: '/bin/sh',
      args: ['-c', 'echo hi'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stateRoot: '/state',
      threadId: 't',
      runId: 'r',
      callId: 'c',
      stdinMode: 'closed',
      initialStdin: 'private bootstrap\n',
      streamMode: 'lossless',
      requiresDeferredOutputRelease: true,
      outputRedaction: {
        exactMarkers: ['private-token'],
        replacement: '[redacted]',
      },
    }).success,
    true,
  );
  assert.equal(
    startParamsSchema.safeParse({
      executable: '/bin/sh',
      args: ['-c', 'cat'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stateRoot: '/state',
      threadId: 't',
      runId: 'r',
      callId: 'c',
      stdinMode: 'closed',
      initialStdinBase64: Buffer.from([0x00, 0xff]).toString('base64'),
    }).success,
    true,
  );
  assert.equal(
    startParamsSchema.safeParse({
      executable: '/bin/sh',
      args: ['-c', 'cat'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stateRoot: '/state',
      threadId: 't',
      runId: 'r',
      callId: 'c',
      stdinMode: 'closed',
      initialStdin: 'text',
      initialStdinBase64: 'dGV4dA==',
    }).success,
    false,
  );
  assert.equal(
    startParamsSchema.safeParse({
      executable: '/bin/sh',
      args: ['-c', 'cat'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stateRoot: '/state',
      threadId: 't',
      runId: 'r',
      callId: 'c',
      stdinMode: 'closed',
      initialStdinBase64: 'not base64',
    }).success,
    false,
  );
  assert.equal(
    startParamsSchema.safeParse({
      executable: '/bin/sh',
      args: ['-c', 'echo hi'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      stateRoot: '/state',
      threadId: 't',
      runId: 'r',
      callId: 'c',
      stdinMode: 'closed',
      outputRedaction: {
        exactMarkers: [],
        replacement: '[redacted]',
      },
    }).success,
    false,
  );
  assert.equal(
    interactParamsSchema.safeParse({
      stateRoot: '/s',
      threadId: 't',
      outputRef: 'command-output:t/s',
      page: {
        stream: 'stdout',
        offsetBytes: 3,
        limitBytes: 3,
        encoding: 'base64',
        deferRelease: true,
        releaseUpToBytes: 3,
      },
    }).success,
    true,
  );
  assert.equal(
    interactParamsSchema.safeParse({
      stateRoot: '/s',
      threadId: 't',
      outputRef: 'command-output:t/s',
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 0 },
    }).success,
    false,
  );
  assert.equal(
    interactParamsSchema.safeParse({
      stateRoot: '/s',
      threadId: 't',
      outputRef: 'command-output:t/s',
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: 3,
        encoding: 'hex',
      },
    }).success,
    false,
  );
});

void test('initialize result defaults omitted known capabilities to disabled', () => {
  const parsed = initializeResultSchema.parse({
    selectedVersion: '2026-07-24',
    supportedVersions: ['2026-07-24'],
    capabilities: {
      losslessStdio: true,
      futureCapability: true,
    },
    effectiveConfig: {
      inlineMaxBytes: 1024,
      tailRingBytes: 4096,
    },
  });

  assert.deepEqual(parsed.capabilities, {
    deferredOutputRelease: false,
    idempotentStartByInvocation: false,
    initialStdinOnStart: false,
    losslessStdio: true,
    prePersistenceOutputRedaction: false,
    rawInitialStdinOnStart: false,
    rawOutputPages: false,
  });
});

void test('initialize result accepts the protocol-owned capability set', () => {
  const parsed = initializeResultSchema.parse({
    selectedVersion: '2026-07-24',
    supportedVersions: ['2026-07-24'],
    capabilities: COMMAND_HOST_CAPABILITIES,
    effectiveConfig: {
      inlineMaxBytes: 1024,
      tailRingBytes: 4096,
    },
  });

  assert.deepEqual(parsed.capabilities, COMMAND_HOST_CAPABILITIES);
});

void test('waitInitial accepts only the explicit output-ref claim flag', () => {
  assert.equal(
    waitInitialParamsSchema.safeParse({
      outputRef: 'command-output:t/s',
      requiresOutputRef: true,
    }).success,
    true,
  );
  assert.equal(
    waitInitialParamsSchema.safeParse({
      outputRef: 'command-output:t/s',
      requiresOutputRef: false,
    }).success,
    false,
  );
});

void test('session result schemas reject malformed worker payloads', () => {
  const snapshot = {
    outputRef: 'command-output:t/s',
    status: 'running',
    exitCode: null,
    stdout: null,
    stderr: null,
    outputComplete: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutChars: null,
    stderrChars: null,
    durationMs: 0,
    firstOutputAfterMs: null,
    revision: 1,
    stdinOpen: true,
    outputLimitExceeded: null,
  };

  assert.equal(
    startResultSchema.safeParse({
      ok: true,
      outputRef: 'command-output:t/s',
    }).success,
    true,
  );
  assert.equal(
    startResultSchema.safeParse({ ok: true, outputRef: 42 }).success,
    false,
  );

  assert.equal(
    waitInitialResultSchema.safeParse({ ok: true, value: snapshot }).success,
    true,
  );
  assert.equal(
    waitInitialResultSchema.safeParse({
      ok: false,
      reasonCode: 'unknown_reason',
      message: 'not a command-host result',
    }).success,
    false,
  );

  assert.equal(
    interactResultSchema.safeParse({
      ok: true,
      value: { snapshot, page: null },
    }).success,
    true,
  );
  assert.equal(
    interactResultSchema.safeParse({
      ok: true,
      value: {
        snapshot,
        page: {
          stream: 'stdout',
          offsetBytes: 0,
          endOffsetBytes: 3,
          totalBytes: 3,
          limitBytes: 3,
          hasMore: false,
          nextOffsetBytes: null,
          content: 'AP8B',
          contentEncoding: 'base64',
        },
      },
    }).success,
    true,
  );
  assert.equal(
    interactResultSchema.safeParse({
      ok: true,
      value: {
        snapshot: { outputRef: 'command-output:t/s', status: 'running' },
        page: null,
      },
    }).success,
    false,
  );
});

void test('subscribeResultSchema carries per-stream barrier offsets', () => {
  assert.equal(
    subscribeResultSchema.safeParse({
      barrierRevision: 12,
      stdout: { earliestAvailableOffset: 4, barrierOffset: 100 },
      stderr: { earliestAvailableOffset: 0, barrierOffset: 0 },
      resyncRequired: false,
    }).success,
    true,
  );
});
