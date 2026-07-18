import type { RunSubagentModelRouting } from '@geulbat/protocol/run-contract';

import type { ResolvedChildModelPin } from '../daemon/subagent-runtime-contracts.js';

export const TEST_INHERITED_SOL_MODEL_PIN = {
  modelId: 'gpt-5.6-sol',
  providerRunSelection: {
    providerModel: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
    },
    reasoningEffort: 'medium',
  },
  selectionSource: 'inherited',
} as const satisfies ResolvedChildModelPin;

export const TEST_AUTO_SUBAGENT_MODEL_ROUTING = {
  mode: 'auto',
} as const satisfies RunSubagentModelRouting;

export const TEST_CHILD_MODEL_REGISTRATION = {
  modelPin: TEST_INHERITED_SOL_MODEL_PIN,
  subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
} as const;
