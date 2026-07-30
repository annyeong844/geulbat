import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';

import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from '../daemon/llm/provider/provider-options.js';
import type { ResponsesRequestMeasurement } from '../daemon/llm/provider/transport/responses-websocket.js';
import { testThreadId } from './thread-id.js';

export const TEST_PROVIDER_REQUEST_OPTIONS: ProviderRequestOptions = {
  ...resolveProviderRequestOptions({}),
  model: 'gpt-test',
};
export const TEST_REPLAY_SCOPE_ID = `sha256:${'c'.repeat(
  64,
)}` as ProviderReplayScopeId;

export function testRequestMeasurement(
  serializedBytes: number,
  historyBytes = serializedBytes,
): ResponsesRequestMeasurement {
  return {
    serializedBytes,
    dominantPressureSource: 'history',
    serializedBytesBySource: {
      history: historyBytes,
      instructions: 0,
      toolDefinitions: 0,
      envelope: 0,
    },
  };
}

export async function withThread(
  run: (args: { workspaceRoot: string; threadId: string }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-compaction-loop-'),
  );
  try {
    await run({ workspaceRoot, threadId: testThreadId(92) });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
