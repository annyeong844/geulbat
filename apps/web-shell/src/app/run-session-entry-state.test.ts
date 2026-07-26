import test from 'node:test';
import assert from 'node:assert/strict';

import { appendThreadNotification } from './run-session-entry-state.js';
import type { BackgroundNotificationsByThread } from './run-session-state-types.js';
import {
  OTHER_THREAD_ID_VALUE,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

void test('appendThreadNotification keeps every child lifecycle scoped per thread without a hidden count cap', () => {
  let notifications: BackgroundNotificationsByThread = {};
  for (let index = 0; index < 12; index += 1) {
    notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
      kind: 'subagent_activity',
      childRunId: `run-child-${index}`,
      subagentType: 'worker',
      state: 'completed',
    });
  }
  notifications = appendThreadNotification(
    notifications,
    OTHER_THREAD_ID_VALUE,
    {
      kind: 'subagent_activity',
      childRunId: 'other-thread',
      subagentType: 'worker',
      state: 'completed',
    },
  );

  assert.equal(notifications[THREAD_ID_VALUE]?.length, 12);
  assert.deepEqual(
    notifications[THREAD_ID_VALUE]?.map((entry) => entry.childRunId),
    Array.from({ length: 12 }, (_, index) => `run-child-${index}`),
  );
  assert.deepEqual(notifications[OTHER_THREAD_ID_VALUE], [
    {
      kind: 'subagent_activity',
      childRunId: 'other-thread',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
});

void test('appendThreadNotification dedupes terminal replay entries by deliveryId', () => {
  let notifications: BackgroundNotificationsByThread = {};

  notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
    kind: 'subagent_activity',
    deliveryId: 'delivery-1',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'completed',
  });
  notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
    kind: 'subagent_activity',
    deliveryId: 'delivery-1',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'completed',
  });

  assert.equal(notifications[THREAD_ID_VALUE]?.length, 1);
});
