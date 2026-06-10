import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppErrorBoundary } from './AppErrorBoundary.js';

function ThrowingChild(): React.JSX.Element {
  throw new Error('boom');
}

void test('AppErrorBoundary renders a reload fallback when a child throws', () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(AppErrorBoundary, null, createElement(ThrowingChild)),
      );
    });

    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /앱이 예기치 않게 중단되었습니다/);
    assert.match(rendered, /새로고침/);
  } finally {
    console.error = originalConsoleError;
  }
});
