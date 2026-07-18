import {
  isContextUsageUpdatedEventPayload,
  type ContextUsageUpdatedEventPayload,
} from '@geulbat/protocol/run-events';
import { isRecord, tryParseJsonRecord } from '@geulbat/protocol/runtime-utils';

const CONTEXT_USAGE_CACHE_KEY = 'geulbat.shell.context-usage.v1';
const CONTEXT_USAGE_CACHE_VERSION = 1;

type ContextUsageByThread = Record<string, ContextUsageUpdatedEventPayload>;
type ContextUsageStorage = Pick<Storage, 'getItem' | 'setItem'>;

function resolveContextUsageStorage(
  storage?: ContextUsageStorage,
): ContextUsageStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredContextUsageByThread(
  storage?: ContextUsageStorage,
): ContextUsageByThread {
  try {
    const raw = resolveContextUsageStorage(storage)?.getItem(
      CONTEXT_USAGE_CACHE_KEY,
    );
    if (!raw) {
      return {};
    }

    const parsed = tryParseJsonRecord(raw);
    if (
      !parsed.ok ||
      parsed.value.version !== CONTEXT_USAGE_CACHE_VERSION ||
      !isRecord(parsed.value.contextUsageByThread)
    ) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.value.contextUsageByThread).filter(
        (entry): entry is [string, ContextUsageUpdatedEventPayload] =>
          entry[0].trim().length > 0 &&
          isContextUsageUpdatedEventPayload(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function storeContextUsageByThread(
  contextUsageByThread: ContextUsageByThread,
  storage?: ContextUsageStorage,
): void {
  try {
    resolveContextUsageStorage(storage)?.setItem(
      CONTEXT_USAGE_CACHE_KEY,
      JSON.stringify({
        version: CONTEXT_USAGE_CACHE_VERSION,
        contextUsageByThread,
      }),
    );
  } catch {
    // 재진입 캐시가 막혀도 현재 런의 exact event 상태는 그대로 유지한다.
  }
}
