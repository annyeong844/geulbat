import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import { Assistant } from './Assistant.js';

void test('Assistant renders transport-level stream errors as a visible banner', () => {
  const html = renderToStaticMarkup(
    <Assistant
      {...createAssistantProps({
        runState: {
          streamError: '[internal] run channel websocket connection failed',
        },
      })}
    />,
  );

  assert.match(html, /run channel websocket connection failed/);
});
