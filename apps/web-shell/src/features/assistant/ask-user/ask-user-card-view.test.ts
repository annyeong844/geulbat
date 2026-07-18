import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readAskUserCardViewFromToolArgs,
  readAskUserCardViewFromToolCallContent,
} from './ask-user-card-view.js';

void test('ask_user args를 카드 뷰로 읽는다', () => {
  assert.deepEqual(
    readAskUserCardViewFromToolArgs({
      question: '어느 레포에 돌릴까요?',
      options: [
        { label: '각 도구를 자기 레포에', description: '기본 제안' },
        { label: '샘플 레포에' },
      ],
    }),
    {
      question: '어느 레포에 돌릴까요?',
      options: [
        { label: '각 도구를 자기 레포에', description: '기본 제안' },
        { label: '샘플 레포에', description: null },
      ],
    },
  );
});

void test('빈 질문·빈 옵션·비정형 args는 거부한다', () => {
  assert.equal(
    readAskUserCardViewFromToolArgs({
      question: ' ',
      options: [{ label: 'x' }],
    }),
    null,
  );
  assert.equal(
    readAskUserCardViewFromToolArgs({ question: 'q', options: [] }),
    null,
  );
  assert.equal(
    readAskUserCardViewFromToolArgs({
      question: 'q',
      options: [{ label: '' }],
    }),
    null,
  );
  assert.equal(readAskUserCardViewFromToolArgs(null), null);
});

void test('settled tool_call content에서 카드 뷰를 복원하고, 다른 도구는 거부한다', () => {
  assert.deepEqual(
    readAskUserCardViewFromToolCallContent(
      JSON.stringify({
        callId: 'c1',
        tool: 'ask_user',
        args: { question: 'q', options: [{ label: 'a' }] },
      }),
    ),
    { question: 'q', options: [{ label: 'a', description: null }] },
  );
  assert.equal(
    readAskUserCardViewFromToolCallContent(
      JSON.stringify({ tool: 'visualize', args: {} }),
    ),
    null,
  );
});
