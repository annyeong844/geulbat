import {
  callModel,
  type CallModelInput,
  type LLMChunk,
} from '../llm/provider/client.js';
import type { HistoryItem } from '../llm/provider/wire/types.js';
import type {
  GoalVerificationOutcome,
  GoalVerificationVoteRecord,
} from '../sessions/goal-store.js';
import { isRecord } from '../runtime-json.js';
import type { GoalSnapshot, RunId } from './contract.js';
import type { ProviderReplayScopeId } from '../runtime-contracts.js';

const GOAL_VERIFIER_PANEL_SIZE = 3;
const GOAL_COMPLETION_QUORUM = 2;

type GoalVerifierCallModel = (
  input: CallModelInput,
) => AsyncGenerator<LLMChunk>;

interface GoalCompletionPanelResult {
  outcome: GoalVerificationOutcome;
  votes: GoalVerificationVoteRecord[];
}

export interface GoalCompletionVerifier {
  verify(args: {
    goal: GoalSnapshot;
    history: readonly HistoryItem[];
    runId: RunId;
    signal?: AbortSignal;
  }): Promise<GoalCompletionPanelResult>;
}

export async function verifyGoalCompletion(args: {
  goal: GoalSnapshot;
  history: readonly HistoryItem[];
  runId: RunId;
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerRequestOptions: CallModelInput['providerRequestOptions'];
  providerReplayScopeId?: ProviderReplayScopeId;
  callModelImpl?: GoalVerifierCallModel;
  signal?: AbortSignal;
}): Promise<GoalCompletionPanelResult> {
  const callModelImpl = args.callModelImpl ?? callModel;
  const votes = await Promise.all(
    Array.from({ length: GOAL_VERIFIER_PANEL_SIZE }, (_, index) => index).map(
      async (memberIndex): Promise<GoalVerificationVoteRecord> =>
        await requestVerifierVote({
          ...args,
          callModelImpl,
          memberIndex,
        }),
    ),
  );
  return aggregateGoalVerificationVotes(votes);
}

export function aggregateGoalVerificationVotes(
  votes: GoalVerificationVoteRecord[],
): GoalCompletionPanelResult {
  const achievedCount = votes.filter(
    (vote) => vote.verdict === 'achieved',
  ).length;
  if (achievedCount >= GOAL_COMPLETION_QUORUM) {
    return {
      outcome: { kind: 'achieved' },
      votes,
    };
  }
  const incompleteVotes = votes.filter(
    (
      vote,
    ): vote is Extract<
      GoalVerificationVoteRecord,
      { verdict: 'not_achieved' }
    > => vote.verdict === 'not_achieved',
  );
  if (incompleteVotes.length >= GOAL_COMPLETION_QUORUM) {
    return {
      outcome: {
        kind: 'incomplete',
        unmetRequirements: [
          ...new Set(
            incompleteVotes.flatMap((vote) =>
              vote.unmetRequirements.map((requirement) => requirement.trim()),
            ),
          ),
        ],
      },
      votes,
    };
  }
  return {
    outcome: {
      kind: 'unavailable',
      message: 'Goal completion verification did not reach a valid quorum',
    },
    votes,
  };
}

async function requestVerifierVote(args: {
  goal: GoalSnapshot;
  history: readonly HistoryItem[];
  runId: RunId;
  memberIndex: number;
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerRequestOptions: CallModelInput['providerRequestOptions'];
  providerReplayScopeId?: ProviderReplayScopeId;
  callModelImpl: GoalVerifierCallModel;
  signal?: AbortSignal;
}): Promise<GoalVerificationVoteRecord> {
  let finalText: string | undefined;
  let emittedToolCall = false;
  try {
    for await (const chunk of args.callModelImpl({
      history: [
        ...args.history,
        {
          kind: 'user',
          text: [
            'Independently verify whether this Goal is actually complete.',
            `Goal objective: ${args.goal.objective}`,
            'Use concrete execution and tool-result evidence in the conversation history.',
            'Do not accept the agent’s own completion claim as evidence.',
          ].join('\n'),
        },
      ],
      systemPrompt: [
        'You are one independent member of a completion-verification panel.',
        'Judge whether the Goal objective is fully achieved using observable execution evidence.',
        'Return exactly one JSON object and no markdown.',
        'For completion: {"verdict":"achieved"}',
        'For incomplete work: {"verdict":"not_achieved","unmetRequirements":["specific remaining requirement"]}',
      ].join('\n'),
      providerSessionId: `${args.runId}:goal-verifier:${args.memberIndex + 1}`,
      providerWebSocketSessions: args.providerWebSocketSessions,
      providerAuthRuntime: args.providerAuthRuntime,
      providerRequestOptions: args.providerRequestOptions,
      ...(args.providerReplayScopeId === undefined
        ? {}
        : { providerReplayScopeId: args.providerReplayScopeId }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    })) {
      if (chunk.type === 'error') {
        return {
          verdict: 'unavailable',
          reason: `provider_error:${chunk.code}`,
        };
      }
      if (chunk.type === 'tool_call' || chunk.type === 'tool_call_delta') {
        emittedToolCall = true;
      }
      if (chunk.type === 'done') {
        finalText = chunk.finalText ?? chunk.assistantText;
      }
    }
  } catch (error: unknown) {
    return {
      verdict: 'unavailable',
      reason:
        error instanceof Error
          ? `verifier_exception:${error.name}`
          : 'verifier_exception:unknown',
    };
  }
  if (emittedToolCall) {
    return {
      verdict: 'unavailable',
      reason: 'invalid_verifier_tool_call',
    };
  }
  return parseGoalVerifierVote(finalText);
}

function parseGoalVerifierVote(
  finalText: string | undefined,
): GoalVerificationVoteRecord {
  if (finalText === undefined) {
    return { verdict: 'unavailable', reason: 'missing_verifier_output' };
  }
  let value: unknown;
  try {
    value = JSON.parse(finalText);
  } catch {
    return { verdict: 'unavailable', reason: 'invalid_verifier_json' };
  }
  if (!isRecord(value) || typeof value.verdict !== 'string') {
    return { verdict: 'unavailable', reason: 'invalid_verifier_shape' };
  }
  if (
    value.verdict === 'achieved' &&
    Object.keys(value).every((key) => key === 'verdict')
  ) {
    return { verdict: 'achieved' };
  }
  if (
    value.verdict === 'not_achieved' &&
    Object.keys(value).every(
      (key) => key === 'verdict' || key === 'unmetRequirements',
    ) &&
    isNonEmptyStringArray(value.unmetRequirements)
  ) {
    return {
      verdict: 'not_achieved',
      unmetRequirements: value.unmetRequirements.map((requirement) =>
        requirement.trim(),
      ),
    };
  }
  return { verdict: 'unavailable', reason: 'invalid_verifier_shape' };
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) => typeof item === 'string' && item.trim().length > 0,
    )
  );
}
