import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { BackgroundChildResult } from '../subagent-runtime-contracts.js';
import { formatBackgroundResultNote } from './loop-shared.js';

function makeDurableResult(
  label: string,
  result: string,
): BackgroundChildResult {
  const deliveryId = `delivery-${label}`;
  const resultDigest: `sha256:${string}` = `sha256:${createHash('sha256').update(result).digest('hex')}`;
  return {
    deliveryId,
    resultRef: `subagent-result:${deliveryId}`,
    resultDigest,
    parentRunId: testRunId('parent-background-note'),
    childRunId: testRunId(`child-${label}`),
    childThreadId: testThreadId(label === 'first' ? 1811 : 1812),
    subagentType: 'explorer',
    terminalState: 'completed',
    result,
    completedAt: '2026-07-26T12:00:00.000Z',
  };
}

void test('background result notes keep one result inline but use durable refs for multi-child fan-in', () => {
  const first = makeDurableResult('first', 'first exact child body');
  const second = makeDurableResult('second', 'second exact child body');
  first.resultReport = {
    summary: 'first compact report',
    sourceResultRef: first.resultRef ?? 'missing',
    sourceResultDigest:
      first.resultDigest ??
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };

  const singleNote = formatBackgroundResultNote([first]);
  assert.match(singleNote, /resultMode: inline/u);
  assert.match(singleNote, /result: first exact child body/u);
  assert.match(singleNote, new RegExp(first.resultDigest ?? 'missing', 'u'));
  assert.match(singleNote, /reportSummary: first compact report/u);
  assert.match(
    singleNote,
    new RegExp(`reportSourceResultRef: ${first.resultRef ?? 'missing'}`, 'u'),
  );

  const fanInNote = formatBackgroundResultNote([first, second]);
  assert.doesNotMatch(fanInNote, /first exact child body/u);
  assert.doesNotMatch(fanInNote, /second exact child body/u);
  assert.equal(fanInNote.match(/resultMode: refs/gu)?.length, 2);
  assert.match(fanInNote, new RegExp(first.deliveryId, 'u'));
  assert.match(fanInNote, new RegExp(first.resultRef ?? 'missing', 'u'));
  assert.match(fanInNote, new RegExp(first.resultDigest ?? 'missing', 'u'));
  assert.match(fanInNote, /reportSummary: first compact report/u);
});
