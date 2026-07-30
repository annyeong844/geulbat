import type { SubagentLaunchRequestInput } from '../daemon/subagent-runtime-contracts.js';

import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from './subagent-model-routing.js';
import { testRunId } from './run-id.js';
import { testThreadId } from './thread-id.js';

export function makeLaunchRequest(
  threadSeed: number,
  toolCallId: string,
): SubagentLaunchRequestInput {
  return {
    toolCallId,
    task: `inspect ${toolCallId}`,
    subagentType: 'explorer',
    capabilities: [],
    parentRunId: testRunId(`parent-${threadSeed}`),
    ownerThreadId: testThreadId(threadSeed),
    stateRoot: '/tmp/geulbat-state',
    workingDirectory: '/tmp/geulbat-workspace',
    modelPin: TEST_INHERITED_SOL_MODEL_PIN,
    subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  };
}
