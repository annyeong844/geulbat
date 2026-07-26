import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';
import { RunPlanCard } from './run-plan/run-plan-card.js';
import type { RunPlanStep } from './run-plan/run-plan.js';

type SubagentActivityEntry = Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
>;

export function AssistantActivityShelf(props: {
  plan: RunPlanStep[] | null;
  entries: SubagentActivityEntry[];
  isRunning: boolean;
  onOpenChildSession?: Parameters<
    typeof RunTranscriptEntryBlock
  >[0]['onOpenChildSession'];
  onStopChildRun?: Parameters<
    typeof RunTranscriptEntryBlock
  >[0]['onStopChildRun'];
}) {
  const { plan, entries, isRunning, onOpenChildSession, onStopChildRun } =
    props;

  if (plan === null && entries.length === 0) {
    return null;
  }

  return (
    <section
      className="assistant-activity-shelf"
      aria-label="현재 화면의 실행 활동"
    >
      {plan !== null ? <RunPlanCard plan={plan} isRunning={isRunning} /> : null}
      {entries.map((entry) => (
        <RunTranscriptEntryBlock
          key={entry.childRunId}
          entry={entry}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onStopChildRun !== undefined ? { onStopChildRun } : {})}
        />
      ))}
    </section>
  );
}
