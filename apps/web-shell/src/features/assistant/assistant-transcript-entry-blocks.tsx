import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';
import { assistantStyles } from './assistant-styles.js';

export function RunTranscriptEntryBlock(props: { entry: RunTranscriptEntry }) {
  const { entry } = props;

  switch (entry.kind) {
    case 'assistant_text':
      return (
        <div style={assistantStyles.commentaryBlock}>
          <div style={assistantStyles.messageRole}>assistant (commentary)</div>
          <pre style={assistantStyles.messageText}>{entry.text}</pre>
        </div>
      );
    case 'tool_activity':
      return (
        <div style={assistantStyles.activityBlock}>
          <div style={assistantStyles.messageRole}>assistant (tool)</div>
          <div style={assistantStyles.activityText}>
            {entry.state === 'running'
              ? `Calling ${entry.tool}`
              : `${entry.tool} ${entry.state}`}
          </div>
        </div>
      );
    case 'approval_request': {
      const summary = buildApprovalSummary(entry.pendingApproval);
      return (
        <div style={assistantStyles.approvalNoticeBlock}>
          <div style={assistantStyles.messageRole}>assistant (approval)</div>
          <div style={assistantStyles.activityText}>{summary.title}</div>
          {summary.detail ? (
            <div style={assistantStyles.approvalNoticeDetail}>
              {summary.detail}
            </div>
          ) : null}
        </div>
      );
    }
    case 'subagent_activity': {
      const title = formatSubagentActivityTitle(entry);
      return (
        <div style={assistantStyles.activityBlock}>
          <div style={assistantStyles.messageRole}>assistant (sub-agent)</div>
          <div style={assistantStyles.activityText}>{title}</div>
          {entry.result ? (
            <div style={assistantStyles.approvalNoticeDetail}>
              {entry.result}
            </div>
          ) : null}
        </div>
      );
    }
  }
}

function formatSubagentActivityTitle(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): string {
  switch (entry.state) {
    case 'spawned':
      return `Spawned ${entry.subagentType} sub-agent`;
    case 'approval_required':
      return `${entry.subagentType} sub-agent awaiting approval`;
    case 'completed':
      return `${entry.subagentType} sub-agent completed`;
    case 'failed':
      return `${entry.subagentType} sub-agent failed`;
    case 'cancelled':
      return `${entry.subagentType} sub-agent cancelled`;
  }
}
