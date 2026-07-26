import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { ProviderUsageEntry } from '@geulbat/protocol/provider-usage';

import { ProviderUsageCard } from './ProviderUsageCard.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function renderCard(
  loadUsage: () => Promise<{ providers: ProviderUsageEntry[] }>,
): Promise<{ renderer: ReactTestRenderer; text: () => string }> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ProviderUsageCard loadUsage={loadUsage} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    renderer,
    text: () => JSON.stringify(renderer.toJSON()),
  };
}

void test('provider-reported windows render as a labelled meter with its reset time', async () => {
  const { renderer, text } = await renderCard(async () => ({
    providers: [
      {
        providerId: 'openai_codex_direct',
        state: 'reported',
        planLabel: 'Plus',
        readAt: '2026-07-26T00:00:00.000Z',
        measurement: {
          kind: 'windows',
          windows: [
            {
              usedPercent: 42,
              windowMinutes: 300,
              resetAt: '2026-07-26T05:00:00.000Z',
            },
          ],
        },
      },
    ],
  }));

  const markup = text();
  assert.match(markup, /Plus/u);
  assert.match(markup, /5시간 한도/u);
  assert.match(markup, /42% 사용/u);
  assert.match(markup, /초기화/u);
  const meter = renderer.root.findAllByProps({ role: 'meter' })[0];
  assert.equal(meter?.props['aria-valuenow'], 42);
  await act(async () => {
    renderer.unmount();
  });
});

void test('a provider that does not report usage says so instead of showing zero', async () => {
  const { renderer, text } = await renderCard(async () => ({
    providers: [
      {
        providerId: 'grok_oauth',
        state: 'not_provided',
        reason: '이 제공자는 사용량 조회를 제공하지 않습니다.',
      },
    ],
  }));

  const markup = text();
  assert.match(markup, /제공 안 함/u);
  assert.match(markup, /제공하지 않습니다/u);
  // 0%로 채운 계량기를 만들지 않는다.
  assert.equal(renderer.root.findAllByProps({ role: 'meter' }).length, 0);
  await act(async () => {
    renderer.unmount();
  });
});

void test('a failed provider lookup is shown as a failure, not as no usage', async () => {
  const { renderer, text } = await renderCard(async () => ({
    providers: [
      {
        providerId: 'openai_codex_direct',
        state: 'failed',
        message: '제공자가 사용량 조회를 거부했습니다 (HTTP 403).',
      },
    ],
  }));

  const markup = text();
  assert.match(markup, /조회 실패/u);
  assert.match(markup, /HTTP 403/u);
  assert.equal(renderer.root.findAllByProps({ role: 'meter' }).length, 0);
  await act(async () => {
    renderer.unmount();
  });
});

void test('an unreachable daemon surfaces an error instead of an empty usage list', async () => {
  const { renderer, text } = await renderCard(async () => {
    throw new Error('offline');
  });

  const markup = text();
  assert.match(markup, /불러오지 못했습니다/u);
  assert.equal(renderer.root.findAllByProps({ role: 'meter' }).length, 0);
  await act(async () => {
    renderer.unmount();
  });
});

void test('reloading asks the provider again rather than reusing a cached snapshot', async () => {
  let calls = 0;
  const { renderer } = await renderCard(async () => {
    calls += 1;
    return {
      providers: [{ providerId: 'grok_oauth', state: 'not_connected' }],
    };
  });
  assert.equal(calls, 1);

  const reload = renderer.root
    .findAllByType('button')
    .find((node) => String(node.props.children) === '다시 불러오기');
  assert.ok(reload);
  await act(async () => {
    reload.props.onClick();
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(calls, 2);
  await act(async () => {
    renderer.unmount();
  });
});
