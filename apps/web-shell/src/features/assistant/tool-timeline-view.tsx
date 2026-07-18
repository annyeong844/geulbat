import { parseToolCallDiff } from './tool-call-diff.js';
import { parseToolResultView } from './tool-result-view.js';
import { ToolDiffBlock } from './assistant-transcript-message.js';
import {
  readToolTimelineRequestBody,
  resolveToolTimelineGlyph,
  type ToolTimelineItem,
} from './tool-timeline.js';

// 도구 활동 타임라인 — 아이콘 행을 세로 연결선으로 잇고, 페이로드가 있는
// 행은 펼치면 Request/Response 카드를 보여준다. 그룹이 끝났으면 마지막에
// 완료 행을 붙인다 (디자인개편 참조안).
export function ToolTimeline(props: {
  items: ToolTimelineItem[];
  running: boolean;
}) {
  const { items, running } = props;
  const failed = items.some((item) => item.state === 'failed');
  return (
    <div className="tool-timeline">
      {items.map((item) => (
        <ToolTimelineRow key={item.key} item={item} />
      ))}
      {running ? null : (
        <div className="tool-timeline-row tool-timeline-terminal">
          <span
            className={`tool-timeline-glyph${failed ? ' failed' : ' done'}`}
            aria-hidden="true"
          >
            {failed ? '!' : '✓'}
          </span>
          <span className="tool-timeline-label">
            {failed ? '일부 실패' : '완료'}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolTimelineRow(props: { item: ToolTimelineItem }) {
  const { item } = props;
  const glyph = resolveToolTimelineGlyph(item);
  const stateGlyph =
    item.state === 'running' ? '…' : item.state === 'failed' ? '!' : null;
  const requestBody = readToolTimelineRequestBody(item.toolCallContent);
  const requestDiff =
    item.toolCallContent !== null
      ? parseToolCallDiff(item.toolCallContent)
      : null;
  const responseView =
    item.toolResultContent !== null
      ? parseToolResultView(item.toolResultContent)
      : null;
  const hasDetail =
    requestDiff !== null || requestBody !== null || responseView !== null;

  if (!hasDetail) {
    return (
      <div className="tool-timeline-row">
        <span className="tool-timeline-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="tool-timeline-label">{item.label}</span>
        {stateGlyph !== null ? (
          <span
            className={`tool-timeline-state${
              item.state === 'failed' ? ' failed' : ''
            }`}
            aria-hidden="true"
          >
            {stateGlyph}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <details className="tool-timeline-item">
      <summary className="tool-timeline-row">
        <span className="tool-timeline-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="tool-timeline-label">{item.label}</span>
        {stateGlyph !== null ? (
          <span
            className={`tool-timeline-state${
              item.state === 'failed' ? ' failed' : ''
            }`}
            aria-hidden="true"
          >
            {stateGlyph}
          </span>
        ) : null}
        <span className="tool-timeline-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="tool-timeline-card">
        {requestDiff !== null ? (
          <ToolDiffBlock diff={requestDiff} />
        ) : requestBody !== null ? (
          <div className="tool-timeline-section">
            <div className="tool-timeline-section-label">Request</div>
            <pre className="tool-timeline-section-body">{requestBody}</pre>
          </div>
        ) : null}
        {responseView !== null ? (
          <div className="tool-timeline-section">
            <div className="tool-timeline-section-label">Response</div>
            <pre className="tool-timeline-section-body">
              {responseView.bodyLines.length === 0
                ? '(출력 없음)'
                : responseView.bodyLines.join('\n')}
              {responseView.truncatedLineCount > 0
                ? `\n… ${responseView.truncatedLineCount}줄 더 있음`
                : ''}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
