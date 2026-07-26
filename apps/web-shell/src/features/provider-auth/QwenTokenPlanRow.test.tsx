import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { QwenTokenPlanRow } from './QwenTokenPlanRow.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('Qwen Token Plan row connects a stored key, clears it, and disconnects', async () => {
  const submitted: Array<{ apiKey: string; region: 'global' | 'china' }> = [];
  let connected = false;
  const api = {
    async getStatus() {
      return connected
        ? ({
            state: 'ready',
            source: 'stored',
            region: 'china',
            baseUrl:
              'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          } as const)
        : ({
            state: 'missing',
            region: 'global',
            baseUrl:
              'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
          } as const);
    },
    async connect(args: { apiKey: string; region: 'global' | 'china' }) {
      submitted.push(args);
      connected = true;
      return {
        state: 'ready',
        source: 'stored',
        region: args.region,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      } as const;
    },
    async disconnect() {
      connected = false;
    },
  };
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(<QwenTokenPlanRow api={api} />);
  });
  assert.equal(
    renderer.root.findAllByProps({
      'aria-label': 'Qwen Token Plan API 키',
    }).length,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(renderer.toJSON()),
    /Qwen3\.8 Max Preview/,
  );

  const openEditor = async () => {
    const connectButton = renderer.root
      .findAllByType('button')
      .find((node) => node.children.includes('연결'));
    assert.ok(connectButton);
    await act(async () => connectButton.props.onClick());
  };
  await openEditor();

  const apiKey = 'x'.repeat(32);
  await act(async () => {
    renderer.root
      .findByProps({ 'aria-label': 'Qwen Token Plan API 키' })
      .props.onChange({ target: { value: apiKey } });
  });
  const cancel = renderer.root
    .findAllByType('button')
    .find((node) => node.children.includes('취소'));
  assert.ok(cancel);
  await act(async () => cancel.props.onClick());
  assert.equal(JSON.stringify(renderer.toJSON()).includes(apiKey), false);
  assert.equal(renderer.root.findAllByType('input').length, 0);

  await openEditor();
  await act(async () => {
    renderer.root
      .findByProps({ 'aria-label': 'Qwen Token Plan API 키' })
      .props.onChange({ target: { value: apiKey } });
    renderer.root
      .findByProps({ 'aria-label': 'Qwen Token Plan 리전' })
      .props.onChange({ target: { value: 'china' } });
  });
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.deepEqual(submitted, [{ apiKey, region: 'china' }]);
  assert.equal(JSON.stringify(renderer.toJSON()).includes(apiKey), false);
  assert.equal(
    renderer.root.findAllByProps({
      'aria-label': 'Qwen Token Plan API 키',
    }).length,
    0,
  );

  const disconnect = renderer.root
    .findAllByType('button')
    .find((node) => node.children.includes('연결 해제'));
  assert.ok(disconnect);
  await act(async () => {
    disconnect.props.onClick();
  });
  assert.equal(
    renderer.root.findAllByProps({
      'aria-label': 'Qwen Token Plan API 키',
    }).length,
    0,
  );
  assert.ok(
    renderer.root
      .findAllByType('button')
      .some((node) => node.children.includes('연결')),
  );

  await act(async () => renderer.unmount());
});

void test('Qwen Token Plan row explains environment management without a disconnect action', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QwenTokenPlanRow
        api={{
          async getStatus() {
            return {
              state: 'ready',
              source: 'environment',
              region: 'global',
              baseUrl:
                'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
            } as const;
          },
          async connect() {
            throw new Error('connect should not be called');
          },
          async disconnect() {
            throw new Error('disconnect should not be called');
          },
        }}
      />,
    );
  });

  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /환경 변수로 연결됨/);
  assert.doesNotMatch(markup, /연결 해제/);
  assert.equal(renderer.root.findAllByType('input').length, 0);

  await act(async () => renderer.unmount());
});
