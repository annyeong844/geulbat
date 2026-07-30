import assert from 'node:assert/strict';

import type { RunId, ThreadId } from '../ids.js';
import { isRunId, isThreadId } from '../ids.js';

export const TEST_RUN_EVENT_THREAD_ID =
  '11111111-1111-4111-8111-111111111111' as ThreadId;
export const TEST_RUN_EVENT_RUN_ID = 'run-event-1' as RunId;

assert.equal(isThreadId(TEST_RUN_EVENT_THREAD_ID), true);
assert.equal(isRunId(TEST_RUN_EVENT_RUN_ID), true);
