import test from 'node:test';
import assert from 'node:assert/strict';

import { createMergedAbortSignal, mergeAbortSignals } from './abort.js';

void test('mergeAbortSignals removes listeners from remaining sources after one aborts', () => {
  const first = new FakeAbortSignal();
  const second = new FakeAbortSignal();

  const merged = mergeAbortSignals(first, second);

  assert.equal(first.listenerCount(), 1);
  assert.equal(second.listenerCount(), 1);

  first.abort('first');

  assert.equal(merged.aborted, true);
  assert.equal(merged.reason, 'first');
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 0);
});

void test('createMergedAbortSignal cleanup removes listeners when no source aborts', () => {
  const first = new FakeAbortSignal();
  const second = new FakeAbortSignal();

  const merged = createMergedAbortSignal(first, second);

  assert.equal(merged.signal.aborted, false);
  assert.equal(first.listenerCount(), 1);
  assert.equal(second.listenerCount(), 1);

  merged.cleanup();

  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 0);
  assert.equal(merged.signal.aborted, false);
});

class FakeAbortSignal {
  aborted = false;
  reason: unknown;
  #listeners = new Set<FakeAbortHandler>();

  addEventListener(type: string, listener: FakeAbortListener | null): void {
    if (type !== 'abort' || !listener) {
      return;
    }
    this.#listeners.add(asCallback(listener));
  }

  removeEventListener(type: string, listener: FakeAbortListener | null): void {
    if (type !== 'abort' || !listener) {
      return;
    }
    this.#listeners.delete(asCallback(listener));
  }

  abort(reason: unknown): void {
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  listenerCount(): number {
    return this.#listeners.size;
  }
}

type FakeAbortHandler = () => void;
type FakeAbortListener = FakeAbortHandler | { handleEvent: FakeAbortHandler };

function asCallback(listener: FakeAbortListener): FakeAbortHandler {
  if (typeof listener === 'function') {
    return listener;
  }
  return listener.handleEvent;
}
