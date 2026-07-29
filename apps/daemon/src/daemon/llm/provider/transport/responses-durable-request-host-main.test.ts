import assert from 'node:assert/strict';
import test from 'node:test';

import { iterateDurableHttpResponseEvents } from './responses-durable-request-host-main.js';

void test('durable HTTP host accepts one JSON object only when the request explicitly accepts JSON', async () => {
  const response = new Response(JSON.stringify({ request_id: 'video-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  assert.deepEqual(
    await collectEvents(
      iterateDurableHttpResponseEvents(response, 'application/json'),
    ),
    [{ request_id: 'video-1' }],
  );
});

void test('durable HTTP host keeps JSON responses out of the SSE contract by default', async () => {
  const response = new Response(JSON.stringify({ request_id: 'video-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    collectEvents(iterateDurableHttpResponseEvents(response, null)),
    (error: unknown) =>
      error instanceof Error &&
      /not an event stream/u.test(error.message) &&
      Reflect.get(error, 'status') === 200,
  );
});

async function collectEvents(
  events: AsyncIterable<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
