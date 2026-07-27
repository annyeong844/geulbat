/**
 * No-progress policy owner (P7c §5.6).
 *
 * `createAgentRunCompletionPolicy()` already derives a run-local
 * `gapFingerprint` / `evidenceRevision` pair and counts how many times the same
 * pair repeats. This owner decides what that repeat count is allowed to do.
 *
 * The policy is operator-owned and has no default. With no configuration the
 * completion policy stays observation-only, which is the behaviour that shipped
 * with the fingerprinting step, so enabling a stop is an explicit deployment
 * decision rather than a hidden product limit.
 *
 * This budget is deliberately separate from transport retry budgets. A provider
 * reconnect or a model-round retry is a transport event and never advances or
 * consumes a no-progress count; only a repeated completion gap with unchanged
 * canonical evidence does.
 */

export const AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV =
  'GEULBAT_AGENT_NO_PROGRESS_REPEAT_THRESHOLD' as const;
export const AGENT_NO_PROGRESS_ACTION_ENV =
  'GEULBAT_AGENT_NO_PROGRESS_ACTION' as const;

/**
 * `observe` keeps the current continue path and only records the repeat.
 * `stop` ends the run with a distinct `no_progress` reason.
 *
 * A separate `retry` action is intentionally absent: the current completion
 * path already continues the run on every unmet obligation, so `retry` would
 * name the existing behaviour twice. A distinct resample strategy needs its own
 * owner and evidence before it earns a policy value.
 *
 * Both the value list and the action type stay internal. Callers construct a
 * policy with a literal action, so exporting either one would add surface with
 * no consumer.
 */
const AGENT_NO_PROGRESS_ACTIONS = ['observe', 'stop'] as const;

type AgentNoProgressAction = (typeof AGENT_NO_PROGRESS_ACTIONS)[number];

export interface AgentNoProgressPolicy {
  /** Repeat count at which the action applies. Never below 2. */
  repeatThreshold: number;
  action: AgentNoProgressAction;
}

type AgentNoProgressPolicyEnv = Readonly<
  Partial<
    Record<
      | typeof AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV
      | typeof AGENT_NO_PROGRESS_ACTION_ENV,
      string | undefined
    >
  >
>;

/**
 * Resolve the operator policy, or `undefined` when it is not configured.
 *
 * Both values are required together. A partial configuration throws instead of
 * inventing the missing half, because guessing either the threshold or the
 * action would make the product stop or keep looping on a value the operator
 * never chose.
 */
export function resolveAgentNoProgressPolicyFromEnv(
  env: AgentNoProgressPolicyEnv = process.env,
): AgentNoProgressPolicy | undefined {
  const thresholdRaw = env[AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV];
  const actionRaw = env[AGENT_NO_PROGRESS_ACTION_ENV];

  if (thresholdRaw === undefined && actionRaw === undefined) {
    return undefined;
  }

  return Object.freeze({
    repeatThreshold: readRepeatThreshold(thresholdRaw),
    action: readAction(actionRaw),
  });
}

/**
 * Whether a repeat count has reached a configured stop.
 *
 * A threshold of 1 is rejected at parse time, so this can never fire on the
 * first observation of a gap. "No progress" requires an actual repeat with
 * unchanged evidence.
 */
export function shouldStopForNoProgress(args: {
  policy?: AgentNoProgressPolicy | undefined;
  repeatCount: number;
  sameGapAndEvidenceAsPrevious: boolean;
}): boolean {
  if (args.policy === undefined || args.policy.action !== 'stop') {
    return false;
  }
  return (
    args.sameGapAndEvidenceAsPrevious &&
    args.repeatCount >= args.policy.repeatThreshold
  );
}

function readRepeatThreshold(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(
      `${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV} is required when ${AGENT_NO_PROGRESS_ACTION_ENV} is set`,
    );
  }
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `invalid ${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV}: ${value || 'empty'}`,
    );
  }
  const parsed = Number(value);
  // The first observation of a gap is count 1. A threshold of 1 would classify
  // a single unmet obligation as no progress, which is a normal continue.
  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    throw new Error(
      `invalid ${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV}: ${value} (must be 2 or greater)`,
    );
  }
  return parsed;
}

function readAction(raw: string | undefined): AgentNoProgressAction {
  if (raw === undefined) {
    throw new Error(
      `${AGENT_NO_PROGRESS_ACTION_ENV} is required when ${AGENT_NO_PROGRESS_REPEAT_THRESHOLD_ENV} is set`,
    );
  }
  const value = raw.trim();
  if (!isAgentNoProgressAction(value)) {
    throw new Error(
      `invalid ${AGENT_NO_PROGRESS_ACTION_ENV}: ${value || 'empty'} (expected ${AGENT_NO_PROGRESS_ACTIONS.join(' | ')})`,
    );
  }
  return value;
}

function isAgentNoProgressAction(
  value: string,
): value is AgentNoProgressAction {
  return (AGENT_NO_PROGRESS_ACTIONS as readonly string[]).includes(value);
}
