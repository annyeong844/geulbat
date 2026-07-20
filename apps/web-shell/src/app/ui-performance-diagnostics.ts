import { createLogger } from '@geulbat/structured-logger/logger';

interface UiPerformanceLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface LongAnimationFrameScriptTiming {
  duration?: number;
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
}

interface ResponsivenessPerformanceEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: LongAnimationFrameScriptTiming[];
}

const logger = createLogger('ui-performance');

function roundDuration(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function normalizeScriptSourceUrl(
  sourceUrl: string | undefined,
  locationHref: string | undefined,
): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }
  try {
    return new URL(sourceUrl, locationHref).pathname;
  } catch {
    return sourceUrl.split(/[?#]/, 1)[0];
  }
}

function getTopLongAnimationFrameScript(
  scripts: LongAnimationFrameScriptTiming[] | undefined,
  locationHref: string | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return undefined;
  }
  let topScript: LongAnimationFrameScriptTiming | undefined;
  for (const script of scripts) {
    if (!topScript || (script.duration ?? 0) > (topScript.duration ?? 0)) {
      topScript = script;
    }
  }
  if (!topScript) {
    return undefined;
  }
  return {
    durationMs: roundDuration(topScript.duration ?? 0),
    invoker: topScript.invoker,
    sourceUrl: normalizeScriptSourceUrl(topScript.sourceURL, locationHref),
    sourceFunctionName: topScript.sourceFunctionName,
  };
}

export function startUiResponsivenessObserver(
  options: {
    Observer?: typeof PerformanceObserver | null;
    logger?: UiPerformanceLogger;
    locationHref?: string;
  } = {},
): PerformanceObserver | null {
  const Observer =
    options.Observer === undefined
      ? typeof globalThis.PerformanceObserver === 'function'
        ? globalThis.PerformanceObserver
        : null
      : options.Observer;
  const supportedEntryTypes = Observer?.supportedEntryTypes ?? [];
  const entryType = supportedEntryTypes.includes('long-animation-frame')
    ? 'long-animation-frame'
    : supportedEntryTypes.includes('longtask')
      ? 'longtask'
      : null;
  if (Observer === null || entryType === null) {
    return null;
  }

  const performanceLogger = options.logger ?? logger;
  const locationHref = options.locationHref ?? globalThis.location?.href;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new Observer((list) => {
      for (const entry of list.getEntries() as ResponsivenessPerformanceEntry[]) {
        performanceLogger.warn(`browser ${entryType}`, {
          name: entry.name,
          startTimeMs: roundDuration(entry.startTime),
          durationMs: roundDuration(entry.duration),
          blockingDurationMs:
            typeof entry.blockingDuration === 'number'
              ? roundDuration(entry.blockingDuration)
              : undefined,
          scriptCount: Array.isArray(entry.scripts)
            ? entry.scripts.length
            : undefined,
          topScript: getTopLongAnimationFrameScript(
            entry.scripts,
            locationHref,
          ),
        });
      }
    });
    observer.observe({ type: entryType, buffered: true });
    return observer;
  } catch (error: unknown) {
    observer?.disconnect();
    performanceLogger.warn('browser responsiveness observer failed', error);
    return null;
  }
}
