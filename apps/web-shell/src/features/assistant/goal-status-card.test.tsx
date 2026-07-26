import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { assertThreadId } from '@geulbat/protocol/ids';
import type { GoalCommand, GoalSnapshot } from '@geulbat/protocol/goal';
import { GoalStatusCard } from './goal-status-card.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const unavailableGoal: GoalSnapshot = {
  goalId: 'goal-card',
  threadId: assertThreadId('123e4567-e89b-42d3-a456-426614174082'),
  objective: 'Keep verifier details private',
  state: 'verification_unavailable',
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:01:00.000Z',
};

void test('Goal card exposes semantic recovery state without verifier votes', async () => {
  const commands: GoalCommand[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <GoalStatusCard
        goal={{
          snapshot: unavailableGoal,
          busy: false,
          async onCommand(command) {
            commands.push(command);
          },
        }}
      />,
    );
  });

  const text = renderedText(renderer.toJSON());
  assert.match(text, /완료 확인을 다시 시작해 주세요/u);
  assert.match(text, /Keep verifier details private/u);
  assert.doesNotMatch(text, /vote|투표|2\s*\/\s*3/iu);

  const resume = renderer.root
    .findAllByType('button')
    .find((button) => renderedText(button.children) === '목표 계속하기');
  assert.ok(resume);
  await act(async () => {
    resume.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(commands, [
    {
      kind: 'resume',
      threadId: unavailableGoal.threadId,
      goalId: unavailableGoal.goalId,
    },
  ]);
  await act(async () => renderer.unmount());
});

function renderedText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(renderedText).join('');
  }
  if (typeof value === 'object' && value !== null && 'children' in value) {
    return renderedText(value.children);
  }
  return '';
}
