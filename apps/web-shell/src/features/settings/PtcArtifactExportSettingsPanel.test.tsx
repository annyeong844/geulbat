import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { PtcArtifactExportPolicy } from '@geulbat/protocol/ptc-artifacts';

import type { PtcArtifactExportSettingsClient } from '../../lib/api/ptc-artifact-export.js';
import { PtcArtifactExportSettingsPanel } from './PtcArtifactExportSettingsPanel.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('PTC artifact settings submit explicit operator limits in count and MB', async () => {
  let submitted: PtcArtifactExportPolicy | undefined;
  const client: PtcArtifactExportSettingsClient = {
    getStatus: () => Promise.resolve({ state: 'disabled' }),
    enable: (policy) => {
      submitted = policy;
      return Promise.resolve({ state: 'ready', source: 'stored', policy });
    },
    disable: () => Promise.resolve({ state: 'disabled' }),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PtcArtifactExportSettingsPanel client={client} />,
    );
  });

  const inputs = renderer.root.findAllByType('input');
  assert.equal(inputs.length, 3);
  assert.equal(inputs[0]?.props.placeholder, '16개');
  assert.equal(inputs[1]?.props.placeholder, '8 MB');
  assert.equal(inputs[2]?.props.placeholder, '32 MB');
  await act(async () => {
    inputs[0]?.props.onChange({ target: { value: '3' } });
    inputs[1]?.props.onChange({ target: { value: '1' } });
    inputs[2]?.props.onChange({ target: { value: '2' } });
  });
  const enableButton = renderer.root
    .findAllByType('button')
    .find((button) => button.children.includes('켜기'));
  assert.ok(enableButton);
  await act(async () => {
    enableButton.props.onClick();
  });

  assert.deepEqual(submitted, {
    maxFiles: 3,
    maxFileBytes: 1 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
  });
  assert.match(JSON.stringify(renderer.toJSON()), /켜짐/u);
  await act(async () => {
    renderer.unmount();
  });
});

void test('empty PTC limit fields enable with count and MB placeholder defaults', async () => {
  let submitted: PtcArtifactExportPolicy | undefined;
  const client: PtcArtifactExportSettingsClient = {
    getStatus: () => Promise.resolve({ state: 'disabled' }),
    enable: (policy) => {
      submitted = policy;
      return Promise.resolve({ state: 'ready', source: 'stored', policy });
    },
    disable: () => Promise.resolve({ state: 'disabled' }),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PtcArtifactExportSettingsPanel client={client} />,
    );
  });

  const enableButton = renderer.root
    .findAllByType('button')
    .find((button) => button.children.includes('켜기'));
  assert.ok(enableButton);
  await act(async () => {
    enableButton.props.onClick();
  });

  assert.deepEqual(submitted, {
    maxFiles: 16,
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
  });
  assert.match(JSON.stringify(renderer.toJSON()), /켜짐/u);
  await act(async () => {
    renderer.unmount();
  });
});

void test('loaded PTC policy shows MB units instead of raw bytes', async () => {
  const client: PtcArtifactExportSettingsClient = {
    getStatus: () =>
      Promise.resolve({
        state: 'ready',
        source: 'stored',
        policy: {
          maxFiles: 5,
          maxFileBytes: 4 * 1024 * 1024,
          maxTotalBytes: 16 * 1024 * 1024,
        },
      }),
    enable: (policy) =>
      Promise.resolve({ state: 'ready', source: 'stored', policy }),
    disable: () => Promise.resolve({ state: 'disabled' }),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PtcArtifactExportSettingsPanel client={client} />,
    );
  });

  const inputs = renderer.root.findAllByType('input');
  assert.equal(inputs[0]?.props.value, '5');
  assert.equal(inputs[1]?.props.value, '4');
  assert.equal(inputs[2]?.props.value, '16');
  await act(async () => {
    renderer.unmount();
  });
});
