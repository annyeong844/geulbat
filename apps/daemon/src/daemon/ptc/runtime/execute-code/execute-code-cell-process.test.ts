import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { startExecuteCodeCellProcess } from './execute-code-cell-process.js';

void test('startExecuteCodeCellProcess drains incremental output until terminal exit', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      [
        'process.stdout.write("first\\n");',
        'setTimeout(() => process.stderr.write("second\\n"), 20);',
        'setTimeout(() => process.exit(0), 40);',
      ].join(''),
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.equal(first.stdout, 'first\n');
  assert.equal(first.stderr, '');

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'exit',
    exitCode: 0,
    processTerminated: true,
  });
  const second = started.handle.drainNewOutput();
  assert.equal(second.stdout, '');
  assert.equal(second.stderr, 'second\n');
});

void test('startExecuteCodeCellProcess exposes an output change wait', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      [
        'setTimeout(() => process.stdout.write("later\\n"), 20);',
        'setTimeout(() => process.exit(0), 40);',
      ].join(''),
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  if (
    started.handle.getOutputRevision === undefined ||
    started.handle.waitForOutputChange === undefined
  ) {
    assert.fail('detached process handle must expose output observation');
  }

  const beforeOutput = started.handle.getOutputRevision();
  const changedRevision =
    await started.handle.waitForOutputChange(beforeOutput);
  assert.ok(changedRevision > beforeOutput);

  const output = started.handle.drainNewOutput();
  assert.equal(output.stdout, 'later\n');
  assert.equal(output.stderr, '');

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
});

void test('startExecuteCodeCellProcess preserves large terminal output', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const output = started.handle.drainNewOutput();
  assert.equal(Buffer.byteLength(output.stdout, 'utf8'), 80 * 1024);
  assert.equal(Buffer.byteLength(output.stderr, 'utf8'), 80 * 1024);
  assert.doesNotMatch(output.stdout, /\[truncated\]/u);
  assert.doesNotMatch(output.stderr, /\[truncated\]/u);
});

void test('startExecuteCodeCellProcess terminates when undrained output exceeds policy', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);',
    ],
    outputBufferPolicy: { maxBufferedBytesPerStream: 1024 },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'output_limit_exceeded',
    exitCode: null,
    processTerminated: false,
    stream: 'stdout',
    maxBufferedBytesPerStream: 1024,
  });
  const output = started.handle.drainNewOutput();
  assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 1024);
});

void test('startExecuteCodeCellProcess terminates the cell process when timeoutMs expires', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 20,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'timeout',
    exitCode: null,
    processTerminated: false,
  });
});

void test('startExecuteCodeCellProcess streams safe output before a split redaction marker completes', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      [
        'process.stdout.write("visible-before-");',
        'setTimeout(() => process.stdout.write("token\\n"), 200);',
        'setTimeout(() => process.exit(0), 240);',
      ].join(''),
    ],
    redactionMarkers: ['token'],
    redactionReplacement: '[redacted:ptc-callback]',
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.ok(first.stdout.length > 0);
  assert.doesNotMatch(first.stdout, /token/u);
  assert.equal(first.stderr, '');

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const final = started.handle.drainNewOutput();
  assert.equal(
    first.stdout + final.stdout,
    'visible-before-[redacted:ptc-callback]\n',
  );
  assert.equal(final.stderr, '');
});

void test('startExecuteCodeCellProcess preserves large streamed output across redaction holdback', async () => {
  const repeatCount = 12_000;
  const marker = 'secret-marker';
  const replacement = '[redacted:ptc-callback]';
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      [
        `const prefix = "visible-".repeat(${repeatCount});`,
        'process.stdout.write(prefix);',
        `setTimeout(() => process.stdout.write(${JSON.stringify(marker)}), 120);`,
        'setTimeout(() => process.exit(0), 180);',
      ].join(''),
    ],
    redactionMarkers: [marker],
    redactionReplacement: replacement,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.ok(first.stdout.length > 0);
  assert.doesNotMatch(first.stdout, new RegExp(marker, 'u'));

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const final = started.handle.drainNewOutput();
  const aggregate = first.stdout + final.stdout;
  const expected = 'visible-'.repeat(repeatCount) + replacement;

  assert.equal(aggregate, expected);
  assert.equal(
    Buffer.byteLength(aggregate, 'utf8'),
    Buffer.byteLength(expected, 'utf8'),
  );
  assert.doesNotMatch(aggregate, new RegExp(marker, 'u'));
  assert.doesNotMatch(aggregate, /\[truncated\]/u);
  assert.equal(first.stderr + final.stderr, '');
});

void test('startExecuteCodeCellProcess terminate latches signal exit semantics', async () => {
  const started = startExecuteCodeCellProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  started.handle.terminate({ graceMs: 10 });
  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'signal',
    exitCode: null,
    processTerminated: false,
  });
});
