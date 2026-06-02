import test from 'node:test';
import assert from 'node:assert/strict';

import { registerProcessFatalLogging } from './daemon/utils/process-fatal-logging.js';

void test('registerProcessFatalLogging observes uncaught exceptions without swallowing them', () => {
  const registered: Array<{
    event: string;
    listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void;
  }> = [];
  const errors: unknown[][] = [];

  registerProcessFatalLogging({
    process: {
      on: (event, listener) => {
        registered.push({ event, listener });
      },
    },
    logger: {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
  });

  assert.deepEqual(
    registered.map((entry) => entry.event),
    ['uncaughtExceptionMonitor'],
  );

  registered[0]?.listener(new Error('boom'), 'uncaughtException');

  assert.deepEqual(errors, [
    [
      'uncaught exception:',
      {
        message: 'boom',
        origin: 'uncaughtException',
      },
    ],
  ]);
});
