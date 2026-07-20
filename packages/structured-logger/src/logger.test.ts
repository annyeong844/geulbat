import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from './logger.js';

type ConsoleMethod = 'log' | 'warn' | 'error';

interface CapturedConsoleCall {
  args: unknown[];
  method: ConsoleMethod;
}

function captureConsoleCalls(run: () => void): CapturedConsoleCall[] {
  const calls: CapturedConsoleCall[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    calls.push({ args, method: 'log' });
  };
  console.warn = (...args: unknown[]) => {
    calls.push({ args, method: 'warn' });
  };
  console.error = (...args: unknown[]) => {
    calls.push({ args, method: 'error' });
  };

  try {
    run();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  return calls;
}

void test('createLogger emits the ISO timestamp, level, scope, and sorted scalar context', () => {
  const calls = captureConsoleCalls(() => {
    createLogger('agent/run', {
      z: 2,
      omitted: undefined,
      empty: null,
      disabled: false,
      a: 'two words',
    }).info('started');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'log');
  assert.equal(calls[0]?.args.length, 1);
  assert.match(
    calls[0]?.args[0] as string,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info \[agent\/run\] started a="two words" disabled=false empty=null z=2$/,
  );
});

void test('withContext merges context without mutating the parent logger', () => {
  const logger = createLogger('scope', { a: 'parent', keep: true });
  const calls = captureConsoleCalls(() => {
    logger.withContext({ a: 'child', next: 3 }).warn('child');
    logger.warn('parent');
  });

  assert.match(
    calls[0]?.args[0] as string,
    / warn \[scope\] child a="child" keep=true next=3$/,
  );
  assert.match(
    calls[1]?.args[0] as string,
    / warn \[scope\] parent a="parent" keep=true$/,
  );
});

void test('each level uses its matching console sink and preserves extra arguments', () => {
  const detail = { reason: 'test' };
  const calls = captureConsoleCalls(() => {
    const logger = createLogger('sink');
    logger.info('info', detail);
    logger.warn('warn', detail);
    logger.error('error', detail);
  });

  assert.deepEqual(
    calls.map(({ method }) => method),
    ['log', 'warn', 'error'],
  );
  assert.deepEqual(
    calls.map(({ args }) => args[1]),
    [detail, detail, detail],
  );
  assert.match(calls[0]?.args[0] as string, / info \[sink\] info$/);
  assert.match(calls[1]?.args[0] as string, / warn \[sink\] warn$/);
  assert.match(calls[2]?.args[0] as string, / error \[sink\] error$/);
});
