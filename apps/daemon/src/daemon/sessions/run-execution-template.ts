import { isRunRequest, type RunRequest } from '@geulbat/protocol/run-contract';
import { isRecord } from '../runtime-json.js';

export type RunExecutionTemplate = Omit<
  RunRequest,
  | 'prompt'
  | 'displayPrompt'
  | 'threadId'
  | 'planModeRequested'
  | 'planModeIntensity'
  | 'planModeDepth'
  | 'approvedPlanRef'
  | 'goalModeRequested'
  | 'goalRef'
  | 'attachments'
  | 'regenerate'
  | 'silentPrompt'
  | 'promptOrigin'
>;

export function isRunExecutionTemplate(
  value: unknown,
): value is RunExecutionTemplate {
  return (
    isRecord(value) &&
    isRunRequest({
      prompt: '',
      ...value,
    })
  );
}
