import type { RunContext } from '../daemon/run-context.js';
import { testThreadId } from './thread-id.js';

export function makeRunContext(
  overrides: Partial<RunContext> = {},
): RunContext {
  return {
    threadId: testThreadId(900),
    stateRoot: '/tmp/home-state',
    workingDirectory: '',
    ...overrides,
  };
}
