import test from 'node:test';
import assert from 'node:assert/strict';

import { createSignal } from './signal.js';

void test('signal isolates listener failures and continues delivery', () => {
  const seen: string[] = [];
  const errors: unknown[] = [];
  const signal = createSignal<[string]>({
    onListenerError(error) {
      errors.push(error);
    },
  });

  signal.subscribe(() => {
    throw new Error('listener boom');
  });
  signal.subscribe((value) => {
    seen.push(value);
  });

  signal.emit('safe');

  assert.deepEqual(seen, ['safe']);
  assert.equal(errors.length, 1);
});

void test('signal unsubscribe is idempotent and remains safe after clear', () => {
  let emptyCount = 0;
  const signal = createSignal<[]>({
    onEmpty() {
      emptyCount += 1;
    },
  });

  const unsubscribe = signal.subscribe(() => {});

  unsubscribe();
  unsubscribe();
  signal.clear();
  unsubscribe();

  assert.equal(emptyCount, 1);
});

void test('signal reports callback failures from onListenerError and onEmpty without breaking delivery', () => {
  const seen: string[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const signal = createSignal<[string]>({
    onListenerError() {
      throw new Error('onListenerError boom');
    },
    onEmpty() {
      throw new Error('onEmpty boom');
    },
  });

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const unsubscribe = signal.subscribe(() => {
      throw new Error('listener boom');
    });
    signal.subscribe((value) => {
      seen.push(value);
    });

    assert.doesNotThrow(() => signal.emit('safe'));
    assert.doesNotThrow(() => unsubscribe());
    assert.doesNotThrow(() => signal.clear());
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(seen, ['safe']);
  assert.equal(warnings.length, 2);

  const [listenerHookWarning, emptyHookWarning] = warnings;
  assert.ok(listenerHookWarning);
  assert.ok(emptyHookWarning);
  assert.match(
    String(listenerHookWarning[0]),
    /warn \[signal\] signal lifecycle hook failed: hook="onListenerError"/,
  );
  assert.equal(listenerHookWarning[1], 'onListenerError boom');
  assert.match(
    String(emptyHookWarning[0]),
    /warn \[signal\] signal lifecycle hook failed: hook="onEmpty"/,
  );
  assert.equal(emptyHookWarning[1], 'onEmpty boom');
});

void test('signal applies subscribe changes on the subsequent emit', () => {
  const seen: string[] = [];
  const signal = createSignal<[string]>();
  let subscribed = false;

  signal.subscribe((value) => {
    seen.push(`current:${value}`);
    if (subscribed) {
      return;
    }
    subscribed = true;
    signal.subscribe((nextValue) => {
      seen.push(`later:${nextValue}`);
    });
  });

  signal.emit('one');
  signal.emit('two');

  assert.deepEqual(seen, ['current:one', 'current:two', 'later:two']);
});
