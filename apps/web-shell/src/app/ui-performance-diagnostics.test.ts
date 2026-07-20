import assert from 'node:assert/strict';
import test from 'node:test';

import { startUiResponsivenessObserver } from './ui-performance-diagnostics.js';

let latestObserver: CapturingPerformanceObserver | null = null;

class CapturingPerformanceObserver implements PerformanceObserver {
  static supportedEntryTypes: string[] = [];
  static failObserve = false;

  readonly callback: PerformanceObserverCallback;
  disconnected = false;
  observedOptions: PerformanceObserverInit | null = null;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    latestObserver = this;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  observe(options?: PerformanceObserverInit): void {
    if (CapturingPerformanceObserver.failObserve) {
      throw new Error('observe failed');
    }
    this.observedOptions = options ?? {};
  }

  takeRecords(): PerformanceEntryList {
    return [];
  }

  emit(entries: PerformanceEntry[]): void {
    const list: PerformanceObserverEntryList = {
      getEntries: () => entries,
      getEntriesByName: (name) =>
        entries.filter((entry) => entry.name === name),
      getEntriesByType: (type) =>
        entries.filter((entry) => entry.entryType === type),
    };
    this.callback(list, this);
  }
}

function performanceEntry(args: {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  blockingDuration?: number;
  scripts?: Array<{
    duration?: number;
    invoker?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
  }>;
}): PerformanceEntry {
  return {
    ...args,
    toJSON: () => ({ ...args }),
  };
}

function resetObserver(entryTypes: string[]): void {
  CapturingPerformanceObserver.supportedEntryTypes = entryTypes;
  CapturingPerformanceObserver.failObserve = false;
  latestObserver = null;
}

void test('records long animation frame evidence with the slowest script source normalized', () => {
  resetObserver(['longtask', 'long-animation-frame']);
  const warnings: Array<{ message: string; detail: unknown }> = [];
  const observer = startUiResponsivenessObserver({
    Observer: CapturingPerformanceObserver,
    locationHref: 'http://localhost:5173/thread/one',
    logger: {
      warn(message, detail) {
        warnings.push({ message, detail });
      },
    },
  });

  assert.equal(observer, latestObserver);
  assert.deepEqual(latestObserver?.observedOptions, {
    type: 'long-animation-frame',
    buffered: true,
  });

  latestObserver?.emit([
    performanceEntry({
      name: 'self',
      entryType: 'long-animation-frame',
      startTime: 12.4,
      duration: 97.6,
      blockingDuration: 47.2,
      scripts: [
        { duration: 12, sourceURL: 'http://localhost:5173/src/fast.ts?t=1' },
        {
          duration: 68.8,
          invoker: 'Window.requestAnimationFrame',
          sourceURL: 'http://localhost:5173/src/slow.ts?t=2#frame',
          sourceFunctionName: 'measureRows',
        },
      ],
    }),
  ]);

  assert.deepEqual(warnings, [
    {
      message: 'browser long-animation-frame',
      detail: {
        name: 'self',
        startTimeMs: 12,
        durationMs: 98,
        blockingDurationMs: 47,
        scriptCount: 2,
        topScript: {
          durationMs: 69,
          invoker: 'Window.requestAnimationFrame',
          sourceUrl: '/src/slow.ts',
          sourceFunctionName: 'measureRows',
        },
      },
    },
  ]);
});

void test('falls back to long tasks when long animation frames are unavailable', () => {
  resetObserver(['longtask']);
  const warnings: string[] = [];
  startUiResponsivenessObserver({
    Observer: CapturingPerformanceObserver,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(latestObserver?.observedOptions, {
    type: 'longtask',
    buffered: true,
  });
  latestObserver?.emit([
    performanceEntry({
      name: 'self',
      entryType: 'longtask',
      startTime: 1,
      duration: 52,
    }),
  ]);
  assert.deepEqual(warnings, ['browser longtask']);
});

void test('stays inactive when the browser exposes neither responsiveness entry type', () => {
  resetObserver([]);

  assert.equal(
    startUiResponsivenessObserver({ Observer: CapturingPerformanceObserver }),
    null,
  );
  assert.equal(latestObserver, null);
});

void test('disconnects and reports observer setup failures', () => {
  resetObserver(['longtask']);
  CapturingPerformanceObserver.failObserve = true;
  const warnings: string[] = [];

  assert.equal(
    startUiResponsivenessObserver({
      Observer: CapturingPerformanceObserver,
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    }),
    null,
  );
  assert.equal(latestObserver?.disconnected, true);
  assert.deepEqual(warnings, ['browser responsiveness observer failed']);
});
