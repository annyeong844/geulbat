import type { PtcExecuteCodePlacementBatchRunner } from '../daemon/ptc/runtime/execute-code/execute-code-placement-contract.js';
import type { PtcSessionDockerManager } from '../daemon/ptc/lab/session/session-docker-contract.js';

export function createUnusedPlacementDependencies() {
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  } satisfies PtcSessionDockerManager;
  const batchRunner = {
    async runPtcLabSessionBatchCommand() {
      throw new Error('not used by placement acquisition');
    },
  } satisfies PtcExecuteCodePlacementBatchRunner;
  return { sessionManager, batchRunner };
}
